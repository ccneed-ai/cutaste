// Public installation plumbing. Benchmarking and inference remain in the npm core.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, mkdtemp, chmod, symlink, lstat } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join, isAbsolute } from 'node:path';
import { LEGACY_VERSION, dataHome, delay, validPackage, packageMatchesPlatform, npmExecutable, installInto, scripts, sanitized } from './runtime.mjs';

export const COMPATIBILITY = Object.freeze({ launcherProtocol: 1, dataSchema: 1, mcpContract: 1 });
const DAY = 24 * 60 * 60_000;
export const updateRoot = () => join(dataHome(), 'state', 'runtime-updates');
const path = name => join(updateRoot(), name);
export async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) { const delta = Number(a.split('.')[i]) - Number(b.split('.')[i]); if (delta) return Math.sign(delta); }
  return 0;
}
const compatible = value => value && Object.entries(COMPATIBILITY).every(([key, expected]) => value[key] === expected);

// All runtime entry points and the activator use this same lock. Downloads use a
// different lock: a slow registry must never prevent a working core from starting.
export async function withSwitchLock(action) {
  const lock = path('switch.lock');
  await mkdir(updateRoot(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await json(join(lock, 'owner.json')).catch(() => undefined);
      const info = await stat(lock).catch(() => undefined);
      if ((owner?.pid && !alive(owner.pid)) || (!owner && info && Date.now() - info.mtimeMs > 30_000)) {
        // A separate recovery claim prevents two contenders deleting a new owner's lock.
        const recovery = `${lock}.recovery`;
        try {
          await mkdir(recovery);
          try {
            const again = await json(join(lock, 'owner.json')).catch(() => undefined);
            const age = await stat(lock).catch(() => undefined);
            if ((again?.pid && !alive(again.pid)) || (!again && age && Date.now() - age.mtimeMs > 30_000)) await rm(lock, { recursive: true, force: true });
          } finally { await rm(recovery, { recursive: true, force: true }); }
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      if (Date.now() > deadline) throw new Error('Runtime version selection is busy; the installed version was not replaced.');
      await delay(30);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function metadata(root) { return json(join(root, 'package.json')); }
async function acceptable(record) {
  if (!record || !stableVersion(record.version) || !isAbsolute(record.packageRoot || '')) return false;
  if (!await validPackage(record.packageRoot, record.version)) return false;
  const pkg = await metadata(record.packageRoot);
  return compatible(pkg.cutasteUpdate) || record.version === LEGACY_VERSION && !pkg.cutasteUpdate;
}
const apply = (config, record) => { config.packageRoot = record.packageRoot; config.version = record.version; return record.packageRoot; };
const updater = config => ({ updaterEntry: join(scripts, 'launch.mjs'), updaterHost: config.host, updaterVersion: '0.2.2', updaterProtocol: 1 });

/** Pick the data directory's existing version, or adopt a compatible install once. */
export async function selectInstalled(config) {
  return withSwitchLock(async () => {
    const active = await json(path('active.json'));
    if (active) {
      if (!await acceptable(active)) throw new Error('The selected Cutaste runtime is damaged or incompatible. It was not silently downgraded.');
      // Host plugin caches move on a plugin upgrade. Keep the reusable checker
      // pointing at a living launcher, without an older plugin taking it back.
      const currentUpdater = updater(config);
      if (active.updaterEntry !== currentUpdater.updaterEntry && (!stableVersion(active.updaterVersion) || compareVersions(currentUpdater.updaterVersion, active.updaterVersion) >= 0)) {
        await atomicJson(path('active.json'), { ...active, ...currentUpdater });
      }
      apply(config, active);
      return config.packageRoot;
    }
    const pkg = await metadata(config.packageRoot);
    const candidate = { version: pkg?.version, packageRoot: config.packageRoot };
    if (!await acceptable(candidate)) return undefined;
    if ((await liveLeases()).some(lease => lease.version !== candidate.version)) throw new Error('Another Cutaste version is running in this data directory. Finish it before selecting the plugin runtime.');
    const record = { ...candidate, compatibility: COMPATIBILITY, activatedAt: new Date().toISOString(), ...updater(config) };
    await atomicJson(path('active.json'), record);
    return apply(config, record);
  });
}

/** Parent lease covers the full child lifetime, including setup's data preparation. */
export async function acquireRuntime(config, kind = 'command') {
  const lease = path(`leases/${process.pid}-${randomUUID()}.json`);
  await withSwitchLock(async () => {
    const active = await json(path('active.json'));
    if (!await acceptable(active)) throw new Error('No verified runtime is selected.');
    apply(config, active);
    await atomicJson(lease, { pid: process.pid, kind, version: config.version, packageRoot: config.packageRoot, startedAt: Date.now() });
  });
  let released = false;
  return async () => { if (!released) { released = true; await rm(lease, { force: true }); } };
}
async function liveLeases() {
  const leases = [];
  for (const name of await readdir(path('leases')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!name.endsWith('.json')) continue;
    const file = path(`leases/${name}`);
    const lease = await json(file);
    if (!lease || !Number.isSafeInteger(lease.pid)) throw new Error('An unreadable runtime lease prevents safe activation.');
    if (alive(lease.pid)) leases.push(lease);
    else await rm(file, { force: true });
  }
  return leases;
}
function control(state, route, body) {
  return new Promise((resolve, reject) => {
    const content = JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port: state.port, path: route, method: 'POST', timeout: 4000,
      headers: { 'x-taste-control': state.control, 'content-type': 'application/json', 'content-length': Buffer.byteLength(content) } }, res => {
      let output = '';
      res.on('data', chunk => { output += chunk; if (output.length > 64 * 1024) req.destroy(new Error('Excessive local update response.')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(output) }); } catch { reject(new Error('Unrecognized daemon update response.')); } });
      res.on('error', reject);
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Local update check timed out.'))); req.end(content);
  });
}
export async function daemonMatches(config) {
  const state = await json(join(dataHome(), 'state', 'web.json')).catch(() => undefined);
  if (!state || !alive(state.pid) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.control !== 'string') return false;
  const result = await control(state, '/_ctl/ping', {}).catch(() => undefined);
  const version = result?.body?.version ?? state.runtimeVersion ?? (config.version === LEGACY_VERSION ? LEGACY_VERSION : undefined);
  return result?.status === 200 && result.body?.ok === true && result.body?.pid === state.pid && version === config.version;
}
async function stopIdleDaemon(candidate) {
  const state = await json(join(dataHome(), 'state', 'web.json'));
  if (!state || !alive(state.pid)) return true;
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.control !== 'string') return false;
  const result = await control(state, '/_ctl/prepare-update', { version: candidate.version, compatibility: COMPATIBILITY }).catch(() => undefined);
  if (result?.status !== 200 || result.body?.ok !== true || result.body?.status !== 'ready') return false;
  const deadline = Date.now() + 10_000;
  while (alive(state.pid) && Date.now() < deadline) await delay(50);
  return !alive(state.pid); // Never send SIGTERM to make an update succeed.
}

// A daemon may have exited while an assistant is working on a leased evaluation
// ticket. Retain the version until the durable operation has completed as well.
async function durableWorkActive() {
  if (await stat(join(dataHome(), 'me', 'evolve', 'check-migration.partial.json')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) return true;
  const files = async dir => readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of await files(join(dataHome(), 'jobs'))) {
    const job = await json(join(dataHome(), 'jobs', name, 'job.json'));
    if (job && ['queued', 'running'].includes(job.status ?? job.state)) return true;
  }
  const base = join(dataHome(), 'assistant-eval');
  for (const name of await files(join(base, 'sessions'))) {
    if (!name.endsWith('.json')) continue;
    const session = await json(join(base, 'sessions', name));
    if (!session || session.cancelledAt || session.state === 'cancelled' || session.status === 'cancelled') continue;
    for (const ticket of session.tickets || []) {
      const id = typeof ticket === 'string' ? ticket : ticket.id;
      if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('An evaluation ticket cannot be safely inspected.');
      const report = await json(join(base, 'reports', `${id}.json`));
      if (!report || report.state === 'running') return true;
      if (session.coreVersion && report.state === 'completed') {
        for (const kind of report.expectedJudgments || []) {
          if (!['visual', 'requirement'].includes(kind)) throw new Error('An unknown pending judgment prevents activation.');
          if (!await json(join(base, `${kind}-judgments`, `${id}.json`))) return true;
        }
      }
    }
  }
  return false;
}

export async function activatePending(config) {
  const deferred = candidate => setCheck({ status: 'deferred', pendingVersion: candidate.version,
    message: 'Update downloaded; waiting for running sessions, evaluations or the local service to finish.' });
  const candidate = await withSwitchLock(async () => {
    if (!await updatesEnabled()) return undefined;
    const pending = await json(path('pending.json')), active = await json(path('active.json'));
    if (!pending) return undefined;
    if (!await acceptable(pending) || !compatible((await metadata(pending.packageRoot)).cutasteUpdate)) throw new Error('The staged update is invalid or incompatible.');
    if (active && compareVersions(pending.version, active.version) <= 0) { await rm(path('pending.json'), { force: true }); return undefined; }
    if ((await liveLeases()).some(lease => lease.kind !== 'daemon') || await durableWorkActive()) { await deferred(pending); return undefined; }
    return pending;
  });
  if (!candidate) return false;
  // Hashing and the isolated smoke checks can take time on slow disks. They do
  // not hold the admission lock; recheck leases after verification finishes.
  await verifyCandidate(config, candidate.packageRoot, candidate.version);
  return withSwitchLock(async () => {
    if (!await updatesEnabled()) return false;
    const pending = await json(path('pending.json')), active = await json(path('active.json'));
    if (!pending || pending.version !== candidate.version || pending.packageRoot !== candidate.packageRoot) return false;
    if (active && compareVersions(candidate.version, active.version) <= 0) return false;
    if ((await liveLeases()).some(lease => lease.kind !== 'daemon') || await durableWorkActive() || !await stopIdleDaemon(candidate)) { await deferred(candidate); return false; }
    if ((await liveLeases()).length || await durableWorkActive()) return false;
    if (active) await atomicJson(path('previous.json'), active);
    await atomicJson(path('active.json'), { ...candidate, compatibility: COMPATIBILITY, activatedAt: new Date().toISOString(), ...updater(config) });
    await rm(path('pending.json'), { force: true });
    apply(config, candidate);
    await setCheck({ status: 'updated', version: candidate.version, message: 'The verified update is selected for new processes.' });
    return true;
  });
}

async function setCheck(value) {
  const current = await json(path('check.json')).catch(() => undefined);
  await atomicJson(path('check.json'), { ...current, ...value, updatedAt: new Date().toISOString() });
}
async function queryLatest() {
  const npm = await npmExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(npm.command, [...npm.args, 'view', 'cutaste@latest', '--json', '--registry=https://registry.npmjs.org/', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000', '--logs-max=0'],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: { ...process.env, npm_config_logs_max: '0' } });
    let output = '';
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(kill, 20_000);
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) kill(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('npm update check could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('The registry is unavailable; the installed runtime remains selected.')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('The registry returned invalid update metadata.')); }
    });
  });
}

export async function verifyCandidate(config, packageRoot, version) {
  if (!await acceptable({ version, packageRoot }) || !compatible((await metadata(packageRoot)).cutasteUpdate)) throw new Error('The runtime candidate has an incompatible package contract.');
  // npm verifies the registry tarball integrity. Also verify the packaged file
  // manifest when provided, then boot both host entry points in a throwaway home.
  const manifest = await json(join(packageRoot, 'release-manifest.json'));
  if (manifest) {
    if (manifest.version !== version || !compatible(manifest.cutasteUpdate) || !Array.isArray(manifest.files)) throw new Error('The package release manifest is incompatible.');
    if (manifest.platform === 'universal' && (!Array.isArray(manifest.supportedPlatforms) || !manifest.supportedPlatforms.includes(`${process.platform}-${process.arch}`))) throw new Error('The package release manifest does not support this platform.');
    for (const item of manifest.files) {
      if (typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe package manifest path.');
      const file = join(packageRoot, item.path);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes || createHash('sha256').update(await readFile(file)).digest('hex') !== item.sha256) throw new Error('The update failed its file integrity check.');
    }
  }
  await mkdir(config.control, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(config.control, 'verify-'));
  try {
    for (const host of ['codex', 'claude-code']) {
      await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', [join(packageRoot, 'plugins', host, 'cutaste', 'scripts', 'launch.sh'), '--version'], {
          stdio: ['ignore', 'pipe', 'ignore'], detached: true,
          env: { ...process.env, CUTASTE_NODE: process.execPath, CUTASTE_HOME: temporary, TASTE_HOME: temporary, CUTASTE_AUTO_UPDATE: '0', CUTASTE_UPDATER_PROCESS: '1' },
        });
        let output = '';
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
        const timer = setTimeout(kill, 30_000);
        child.stdout.on('data', data => { output += data; if (output.length > 65536) kill(); });
        child.once('error', () => { clearTimeout(timer); reject(new Error('The candidate runtime could not start.')); });
        child.once('close', code => {
          clearTimeout(timer);
          let reported = output.trim();
          try { reported = JSON.parse(reported).version; } catch { /* CLI --version is plain text. */ }
          if (code !== 0 || reported !== version) reject(new Error('The candidate runtime did not pass its version smoke check.'));
          else resolve();
        });
      });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function updatesEnabled() {
  if (['0', 'false', 'off'].includes((process.env.CUTASTE_AUTO_UPDATE || '').toLowerCase())) return false;
  return (await json(path('settings.json')))?.autoUpdate !== false;
}

/** A detached updater waits here; the foreground never waits on the network. */
export async function checkForUpdates(config) {
  let acquired = false, staging;
  const lock = path('download.lock');
  try {
    if (!await updatesEnabled()) { await setCheck({ status: 'disabled' }); return; }
    if (!await selectInstalled(config)) return;
    await mkdir(updateRoot(), { recursive: true, mode: 0o700 });
    try { await mkdir(lock); acquired = true; await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() })); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await json(join(lock, 'owner.json')).catch(() => undefined);
      const info = await stat(lock).catch(() => undefined);
      if (owner?.pid && !alive(owner.pid) || !owner && info && Date.now() - info.mtimeMs > 30_000) {
        await withSwitchLock(async () => {
          const again = await json(join(lock, 'owner.json')).catch(() => undefined);
          const age = await stat(lock).catch(() => undefined);
          if (again?.pid && !alive(again.pid) || !again && age && Date.now() - age.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
        });
      }
      return; // A later launch retries a crashed checker without simultaneous downloads.
    }
    await activatePending(config);
    const previous = await json(path('check.json'));
    if (previous?.checkedAt && Date.now() - Date.parse(previous.checkedAt) < DAY) return;
    await setCheck({ checkedAt: new Date().toISOString(), status: 'checking' });
    const latest = await queryLatest();
    if (latest?.name !== 'cutaste' || !stableVersion(latest.version)) throw new Error('The latest tag did not identify a stable Cutaste version.');
    const active = await json(path('active.json'));
    if (compareVersions(latest.version, active.version) <= 0) {
      await setCheck({ status: (await json(path('pending.json'))) ? 'deferred' : 'current', version: active.version }); return;
    }
    if (!compatible(latest.cutasteUpdate)) {
      await setCheck({ status: 'incompatible', latestVersion: latest.version, message: 'This release needs a compatible plugin or data migration; the installed version remains selected.' }); return;
    }
    if (!packageMatchesPlatform(latest)) {
      await setCheck({ status: 'incompatible', latestVersion: latest.version, message: `This release does not declare support for ${process.platform}-${process.arch}; the installed version remains selected.` }); return;
    }
    const destination = join(config.prefix, 'versions', latest.version);
    const candidate = { version: latest.version, packageRoot: join(destination, 'node_modules', 'cutaste'), compatibility: COMPATIBILITY };
    if (!await acceptable(candidate)) {
      await mkdir(config.control, { recursive: true, mode: 0o700 });
      staging = await mkdtemp(join(config.control, 'update-'));
      await installInto(config, staging, latest.version);
      if (!await acceptable({ ...candidate, packageRoot: join(staging, 'node_modules', 'cutaste') })) throw new Error('The downloaded update failed validation; the previous runtime is unchanged.');
      await verifyCandidate(config, join(staging, 'node_modules', 'cutaste'), latest.version);
      await mkdir(dirname(destination), { recursive: true });
      // Never replace a directory a process may have loaded.
      if (await stat(destination).catch(() => undefined)) throw new Error('An existing version directory failed validation; it was not overwritten.');
      await rename(staging, destination); staging = undefined;
    }
    await atomicJson(path('pending.json'), { ...candidate, downloadedAt: new Date().toISOString() });
    await setCheck({ status: 'downloaded', pendingVersion: latest.version });
    if (await updatesEnabled()) await activatePending(config);
  } catch (error) {
    await setCheck({ status: 'failed', message: sanitized(error.message) }).catch(() => {});
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (acquired) await rm(lock, { recursive: true, force: true });
  }
}

export function scheduleUpdate(config) {
  if (process.env.CUTASTE_UPDATER_PROCESS === '1') return;
  if (['0', 'false', 'off'].includes((process.env.CUTASTE_AUTO_UPDATE || '').toLowerCase())) return;
  const child = spawn(process.execPath, [join(scripts, 'launch.mjs'), config.host, '--update-check'], {
    detached: true, stdio: 'ignore', env: { ...process.env, CUTASTE_UPDATER_PROCESS: '1' },
  });
  child.on('error', () => {}); child.unref();
}

export async function managedCli(config) {
  const file = join(config.prefix, 'bin', 'cutaste.mjs');
  await mkdir(dirname(file), { recursive: true });
  const contents = `#!/usr/bin/env node\nimport {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,[${JSON.stringify(join(scripts, 'launch.mjs'))},${JSON.stringify(config.host)},...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CUTASTE_INSTALL_DIR:process.env.CUTASTE_INSTALL_DIR||${JSON.stringify(config.prefix)},CUTASTE_HOME:process.env.CUTASTE_HOME||process.env.TASTE_HOME||${JSON.stringify(dataHome())}}});\nchild.on('error',()=>{process.stderr.write('Cutaste launcher could not start. Reinstall the plugin.\\n');process.exitCode=1;});\nchild.on('close',code=>{process.exitCode=code??1;});\n`;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o755 }); await chmod(temporary, 0o755);
  await rename(temporary, file);
  const command = join(config.prefix, 'bin', 'cutaste');
  const commandTemp = `${command}.${process.pid}.${randomUUID()}`;
  await symlink('cutaste.mjs', commandTemp); await rename(commandTemp, command);
  const link = join(config.prefix, 'node_modules', '.bin', 'cutaste');
  await mkdir(dirname(link), { recursive: true });
  const info = await lstat(link).catch(() => undefined);
  if (info && !info.isSymbolicLink()) return; // Respect a user's own executable.
  const temp = `${link}.${process.pid}.${randomUUID()}`;
  await symlink('../../bin/cutaste', temp); await rename(temp, link);
}
