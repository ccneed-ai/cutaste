// Installation and transport plumbing only; product behavior stays in the npm core.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimFirstPage, finishFirstPage } from './first-page.mjs';

export const VERSION = '0.1.0';
export const scripts = dirname(fileURLToPath(import.meta.url));
export const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
export function configuration(host) {
  if (!['codex', 'claude-code'].includes(host)) throw new Error('Expected host codex or claude-code.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 12)) throw new Error('Local Node.js >=22.12.0 is required.');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('cutaste@0.1.0 supports Linux x64 only.');
  let prefix = process.env.CUTASTE_INSTALL_DIR || join(homedir(), '.local/share/cutaste');
  if (prefix === '~') prefix = homedir();
  else if (prefix.startsWith('~/')) prefix = join(homedir(), prefix.slice(2));
  prefix = resolve(prefix);
  return { host, prefix, control: join(prefix, '.cutaste-plugin'), packageRoot: join(prefix, 'node_modules/cutaste') };
}
export function sanitized(message) {
  let text = String(message);
  for (const [name, value] of Object.entries(process.env)) {
    if (/(TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION)/i.test(name) && value && value.length >= 6) text = text.split(value).join('[redacted]');
  }
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|api[_-]?key)=)[^\s&]+/gi, '$1[redacted]');
}
export function report(message) { process.stderr.write(`Cutaste: ${sanitized(message)}\n`); }
export async function record(config, status, message) {
  await mkdir(config.control, { recursive: true, mode: 0o700 });
  const value = { version: config.version || VERSION, status, message: sanitized(message), updatedAt: new Date().toISOString() };
  const temporary = join(config.control, `state-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, join(config.control, 'state.json'));
  await appendFile(join(config.control, 'bootstrap.log'), `${value.updatedAt} ${status}: ${value.message}\n`, { mode: 0o600 });
}
export async function installationState(config) {
  try { return JSON.parse(await readFile(join(config.control, 'state.json'), 'utf8')); }
  catch { return undefined; }
}
export async function validPackage(root, expectedVersion = VERSION) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'cutaste' || pkg.version !== expectedVersion) return false;
    for (const host of ['codex', 'claude-code']) {
      const plugin = join(root, 'plugins', host, 'cutaste');
      const manifestBytes = await readFile(join(plugin, 'payload/manifest.json'));
      const manifest = JSON.parse(manifestBytes);
      const supported = JSON.parse(await readFile(join(plugin, 'supported-platform.json'), 'utf8'));
      if (manifest.runtimeKind !== 'local-node' || manifest.platform !== 'linux' || manifest.arch !== 'x64'
        || manifest.requiresPreinstalledNode !== true || manifest.nodeBundled !== false || manifest.channel !== 'stable'
        || supported.coreManifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')) return false;
      for (const name of ['scripts/launch.sh', 'scripts/select-core.mjs', 'prepare-offline.mjs', 'payload/runtime/cutaste.mjs',
        'payload/vendor/axe.min.js', 'payload/vendor/browser/node_modules/playwright/index.mjs', 'offline/base-template/manifest.json', 'offline/fontpack/manifest.json']) {
        const info = await lstat(join(plugin, name));
        if (!info.isFile() || info.isSymbolicLink()) return false;
      }
    }
    return (await stat(join(root, 'bin/cutaste.mjs'))).isFile();
  } catch { return false; }
}
export const officialLauncher = config => join(config.packageRoot, 'plugins', config.host, 'cutaste/scripts/launch.sh');
export const officialEnvironment = config => ({ ...process.env, CUTASTE_NODE: process.execPath, CUTASTE_HOST: config.host });
export function dataHome() {
  let home = process.env.CUTASTE_HOME || process.env.TASTE_HOME || join(homedir(), '.cutaste');
  if (home === '~') home = homedir();
  else if (home.startsWith('~/')) home = join(homedir(), home.slice(2));
  return resolve(home);
}
export async function hasSetupRecord() {
  try { return (await stat(join(dataHome(), 'state', 'plugin-setup.json'))).isFile(); }
  catch { return false; }
}
export function preparationPath(config) {
  const key = createHash('sha256').update(dataHome() + '\0' + config.host).digest('hex');
  return join(config.control, `preparation-${key}.json`);
}
async function recoverStaleLock(lock, recovery) {
  let recovering = false;
  try {
    await mkdir(recovery, { mode: 0o700 }); recovering = true;
    let stale = false;
    try {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid lock owner');
      try { process.kill(owner.pid, 0); }
      catch (error) { stale = error.code === 'ESRCH'; }
    } catch {
      const info = await stat(lock).catch(() => undefined);
      stale = Boolean(info && Date.now() - info.mtimeMs > 30_000);
    }
    if (stale) await rm(lock, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(recovery).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > 30_000) await rm(recovery, { recursive: true, force: true });
  } finally { if (recovering) await rm(recovery, { recursive: true, force: true }); }
}
async function officialJson(config, args, timeout = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('/bin/sh', [officialLauncher(config), ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: officialEnvironment(config) });
    let output = '', timedOut = false, excessive = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) { excessive = true; kill(); } });
    // Read stderr to avoid pipe backpressure. Report the structured problems below, not raw logs.
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('The installed setup command could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('Automatic local setup exceeded its time limit. Reopen the plugin to resume.')); return; }
      if (excessive) { reject(new Error('The installed setup command returned excessive output.')); return; }
      try {
        const value = JSON.parse(output.trim());
        if (!value || typeof value.status !== 'string') throw new Error();
        resolveResult({ value, code });
      } catch { reject(new Error('The installed setup command did not return a valid setup status.')); }
    });
  });
}
export async function prepareRuntime(config) {
  await ensureInstalled(config);
  const { acquireRuntime, daemonMatches } = await import('./updates.mjs');
  const releaseRuntime = await acquireRuntime(config, 'setup');
  try {
  // Different hosts and installation prefixes still share the same data-directory lock.
  const home = dataHome();
  const lock = join(home, 'state', 'plugin-automatic-setup.lock');
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  await mkdir(config.control, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 4 * 60_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Cannot write the automatic setup lock.');
      await recoverStaleLock(lock, lock + '.recovery');
      if (Date.now() > deadline) throw new Error('Another automatic setup did not finish within four minutes. Reopen the plugin to resume.');
      await delay(200);
    }
  }
  try {
    let firstPage;
    try { firstPage = await claimFirstPage(home, process.env); }
    catch { firstPage = { allowOpen: false, outcome: 'unavailable' }; }
    let { value } = await officialJson(config, ['setup', '--status', '--json']);
    const hosts = Array.isArray(value.hosts) ? value.hosts.map(host => typeof host === 'string' ? host : host?.host) : [];
    if (value.status !== 'ready' || !hosts.includes(config.host) || firstPage.allowOpen || !await daemonMatches(config)) {
      ({ value } = await officialJson(config, ['setup', '--host', config.host, ...(firstPage.allowOpen ? [] : ['--no-open']), '--json'], 180_000));
    }
    try { firstPage = await finishFirstPage(home, firstPage, value); } catch { /* Opening is best effort; it must never disable MCP or hooks. */ }
    if (!['ready', 'degraded'].includes(value.status)) throw new Error('Automatic local setup has not completed. Reopen the plugin to resume; no completed setup is being claimed.');
    const sanitizeValue = item => typeof item === 'string' ? sanitized(item) : Array.isArray(item) ? item.map(sanitizeValue)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, sanitizeValue(entry)])) : item;
    const summary = sanitizeValue({ status: value.status, runtimeVersion: config.version, template: value.template, url: value.url,
      opened: firstPage.allowOpen && value.opened === true, firstPage: firstPage.outcome, browser: value.browser, background: value.background, problems: value.problems || [], updatedAt: new Date().toISOString() });
    const destination = preparationPath(config), temporary = destination + `.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(summary) + '\n', { mode: 0o600 });
    await rename(temporary, destination);
    if (firstPage.outcome !== 'already-recorded' && summary.url && !summary.opened) report(`Local page: ${summary.url}. Automatic browser opening was skipped or unavailable; open this address on this computer, or use the optional setup skill.`);
    if (summary.status === 'degraded') report(`Automatic local setup is degraded: ${JSON.stringify(summary.problems)}. The official MCP will report its actual available state.`);
    return summary;
  } finally { await rm(lock, { recursive: true, force: true }); }
  } finally { await releaseRuntime(); }
}

export async function npmExecutable() {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, 'npm');
    try {
      await access(candidate, constants.X_OK);
      const target = await realpath(candidate);
      const firstLine = (await readFile(target, 'utf8')).split('\n', 1)[0];
      return /node(?:\s|$)/.test(firstLine) ? { command: process.execPath, args: [target] } : { command: candidate, args: [] };
    } catch { /* continue through PATH */ }
  }
  throw new Error('npm is unavailable in the assistant PATH. Install local Node.js with npm and restart the assistant.');
}
export async function installInto(config, staging, version = VERSION) {
  const npm = await npmExecutable();
  if (!config.version) await record(config, 'installing', `Downloading and verifying cutaste@${version}; the first download can take several minutes.`);
  await new Promise((resolveInstall, reject) => {
    const child = spawn(npm.command, [...npm.args, 'install', '--prefix', staging, '--registry=https://registry.npmjs.org/',
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', '--logs-max=0', `cutaste@${version}`], {
      // npm output can contain registry credentials. Never copy raw npm output to MCP, hooks or logs.
      stdio: 'ignore', detached: true, env: { ...process.env, npm_config_logs_max: '0' },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 10 * 60_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('npm could not start. Check local npm and network access.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('npm installation exceeded 10 minutes. Check network access; reopening the plugin retries automatically.'));
      else if (code !== 0) reject(new Error(`npm installation failed (exit ${code ?? 'unknown'}). Check network access and npm credentials; reopening the plugin retries automatically.`));
      else resolveInstall();
    });
  });
}
async function ensurePinnedInstalled(config, { forceRetry = false } = {}) {
  if (await validPackage(config.packageRoot)) return config.packageRoot;
  await mkdir(config.control, { recursive: true, mode: 0o700 });
  const lock = join(config.control, 'install.lock');
  const deadline = Date.now() + 11 * 60_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Cannot write the selected CUTASTE_INSTALL_DIR.');
      if (await validPackage(config.packageRoot)) return config.packageRoot;
      // Serialize stale-lock recovery so two waiters cannot remove each other's new lock.
      await recoverStaleLock(lock, join(config.control, 'lock-recovery'));
      if (Date.now() > deadline) throw new Error('Another Cutaste installer did not finish within 11 minutes.');
      await delay(200);
    }
  }
  let staging;
  try {
    if (await validPackage(config.packageRoot)) return config.packageRoot;
    const previousFailure = await installationState(config);
    if (!forceRetry && previousFailure?.status === 'failed' && Date.now() - Date.parse(previousFailure.updatedAt) < 60_000) {
      const error = new Error('The previous installation failed. Automatic downloads pause for 60 seconds; reopen the plugin afterward, or use the optional setup repair command to retry now.');
      error.code = 'CUTASTE_COOLDOWN';
      throw error;
    }
    staging = await mkdtemp(join(config.control, 'staging-'));
    await installInto(config, staging);
    const candidate = join(staging, 'node_modules/cutaste');
    if (!await validPackage(candidate)) throw new Error('The downloaded package is incomplete or does not match cutaste@0.1.0 Linux x64.');
    await mkdir(dirname(config.packageRoot), { recursive: true });
    let previous;
    try {
      await lstat(config.packageRoot);
      previous = join(config.control, `previous-${Date.now()}-${process.pid}`);
      await rename(config.packageRoot, previous);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(candidate, config.packageRoot); }
    catch (error) { if (previous) await rename(previous, config.packageRoot); throw error; }
    const bin = join(config.prefix, 'node_modules/.bin');
    await mkdir(bin, { recursive: true });
    try { await symlink('../cutaste/bin/cutaste.mjs', join(bin, 'cutaste')); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await record(config, 'ready', 'The pinned npm package is ready. This does not mean the local page has started.');
    return config.packageRoot;
  } catch (error) {
    if (error.code !== 'CUTASTE_COOLDOWN') await record(config, 'failed', error.message).catch(() => {});
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function ensureInstalled(config, options = {}) {
  const { selectInstalled, managedCli, activatePending } = await import('./updates.mjs');
  if (!await selectInstalled(config)) {
    await ensurePinnedInstalled(config, options);
    await selectInstalled(config);
  }
  // A staged update may become eligible between sessions without another registry call.
  await activatePending(config).catch(() => {});
  await managedCli(config);
  return config.packageRoot;
}

export async function readHookInput(limit = 1024 * 1024) {
  const chunks = []; let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('Hook input did not finish within 2 seconds; no partial event was forwarded.')), 2000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Hook input exceeds 1 MiB; no truncated event was forwarded.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
export function background(config, args = [], input = Buffer.alloc(0)) {
  const child = spawn(process.execPath, [join(scripts, 'launch.mjs'), config.host, '--background', ...args], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: process.env,
  });
  child.on('error', () => report('The background preparer could not start; reopening the plugin retries automatically.'));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.unref();
  return child;
}
export async function runOfficial(config, args, input) {
  const { acquireRuntime } = await import('./updates.mjs');
  const releaseRuntime = await acquireRuntime(config, args[0] === 'mcp' ? 'mcp' : 'command');
  try { return await new Promise((resolveRun, reject) => {
    const child = spawn('/bin/sh', [officialLauncher(config), ...args], {
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env: officialEnvironment(config),
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const terminate = signal => child.kill(signal);
    const sigint = () => terminate('SIGINT'), sigterm = () => terminate('SIGTERM');
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
    const cleanup = () => { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); };
    child.once('error', () => { cleanup(); reject(new Error('The installed Cutaste runtime could not start.')); });
    child.once('close', code => { cleanup(); resolveRun(code ?? 1); });
  }); } finally { await releaseRuntime(); }
}
