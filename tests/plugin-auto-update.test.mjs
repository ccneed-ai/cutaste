import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// These tests exercise the actual launcher and MCP proxy. Only npm and the
// installed core are fixtures: no registry access, user history or model calls.
const launch = fileURLToPath(new URL('../plugins/cutaste/scripts/launch.mjs', import.meta.url));
const OLD = '0.1.0', NEXT = '0.1.1';
const COMPATIBILITY = { launcherProtocol: 1, dataSchema: 1, mcpContract: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function eventually(read, predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await sleep(30);
  }
  assert.fail(`${description}; last value: ${JSON.stringify(value)}`);
}

const npmFixture = String.raw`
import { readFile, appendFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const registry = JSON.parse(await readFile(process.env.FIXTURE_REGISTRY, 'utf8'));
await appendFile(process.env.FIXTURE_NPM_LOG, JSON.stringify({args,pid:process.pid})+'\n');
if (registry.delay) await new Promise(resolve => setTimeout(resolve,registry.delay));
if (args.includes('view') || args.includes('info')) {
  if (registry.offline) { process.stderr.write('registry unavailable'); process.exit(1); }
  const entry = registry.packages[registry.latest];
  const installed = entry ? JSON.parse(await readFile(join(entry.path,'package.json'),'utf8')) : {};
  const metadata = {name:'cutaste',version:registry.latest,cutasteUpdate:entry?.compatibility,os:installed.os,cpu:installed.cpu,supportedPlatforms:installed.supportedPlatforms};
  if(args.includes('version') && !args.includes('cutasteUpdate')) process.stdout.write(JSON.stringify(registry.latest));
  else if(args.includes('cutasteUpdate') && !args.includes('version')) process.stdout.write(JSON.stringify(entry?.compatibility));
  else process.stdout.write(JSON.stringify(metadata));
} else if (args.includes('install')) {
  const spec=args.find(a=>/^cutaste@/.test(a));
  const requested=spec?.slice('cutaste@'.length);
  const version=requested==='latest'?registry.latest:requested;
  const entry=registry.packages[version];
  const prefix=args[args.indexOf('--prefix')+1];
  if(registry.installFailure || !entry || !prefix) process.exit(1);
  await mkdir(join(prefix,'node_modules'),{recursive:true});
  await cp(entry.path,join(prefix,'node_modules/cutaste'),{recursive:true});
} else {
  process.stderr.write('Unexpected fake npm command: '+args.join(' '));
  process.exit(2);
}
await appendFile(process.env.FIXTURE_NPM_LOG+'.done',JSON.stringify({args,pid:process.pid})+'\n');
`;

const daemonFixture = String.raw`
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
const state=join(process.env.CUTASTE_HOME,'state');
await mkdir(state,{recursive:true});
const server=createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(req.url==='/_ctl/ping') {
    const authenticated=req.headers['x-taste-control']==='fixture-control';
    res.writeHead(authenticated?200:403,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:authenticated,pid:process.pid,version:'0.1.0'}));return;
  }
  const owner=JSON.parse(await readFile(join(state,'runtime-updates/switch.lock/owner.json'),'utf8'));
  process.kill(owner.pid,0);
  await appendFile(join(state,'daemon-requests.jsonl'),JSON.stringify({path:req.url,method:req.method,authenticated:req.headers['x-taste-control']==='fixture-control',body,lockPid:owner.pid})+'\n');
  const mode=(await readFile(join(state,'daemon-mode'),'utf8')).trim();
  if(mode==='legacy'){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'unknown route'}));return;}
  if(mode==='busy'){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,status:'busy',reasons:['evaluation-active']}));return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,status:'ready'}));
  if(mode==='ready')server.close(()=>process.exit(0));
});
server.listen(0,'127.0.0.1',async()=>{
  await writeFile(join(state,'web.json'),JSON.stringify({pid:process.pid,port:server.address().port,control:'fixture-control'}));
});
`;

function coreFixture(version) {
  return String.raw`
import { mkdir,readFile,writeFile,appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const version=${JSON.stringify(version)};
const args=process.argv.slice(2),state=join(process.env.CUTASTE_HOME,'state');
await mkdir(state,{recursive:true});
const log=value=>appendFile(join(state,'core-calls.jsonl'),JSON.stringify({version,args,...value})+'\n');
await log({pid:process.pid});
if(args[0]==='setup') {
  const savedPath=join(state,'plugin-setup.json');
  let saved; try {saved=JSON.parse(await readFile(savedPath,'utf8'));} catch {}
  if(args.includes('--status')) {process.stdout.write(JSON.stringify(saved||{status:'not-ready',hosts:[]}));process.exit(0);}
  const opened=!args.includes('--no-open');
  if(opened) await appendFile(join(state,'browser-opens.jsonl'),'open\n');
  const host=args[args.indexOf('--host')+1];
  const result={status:'ready',hosts:[...new Set([...(saved?.hosts||[]),host])],url:'http://127.0.0.1:43210/',opened,template:'ready',background:'waiting',problems:[]};
  await writeFile(savedPath,JSON.stringify(result));process.stdout.write(JSON.stringify(result));
} else if(args[0]==='hook') {
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:args[1],additionalContext:'core '+version}}));
} else if(args[0]==='fixture-hold') {
  await writeFile(join(state,'hold-ready.json'),JSON.stringify({pid:process.pid,version}));
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){try{await readFile(join(state,'hold-release'));break;}catch{}await new Promise(r=>setTimeout(r,30));}
  process.stdout.write(JSON.stringify({version}));
} else if(args[0]==='mcp') {
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
    const req=JSON.parse(line);
    if(req.id===undefined) continue;
    let result;
    if(req.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'cutaste-fixture',version}};
    else if(req.method==='tools/list')result={tools:[{name:'cutaste_status',description:'Fixture status',inputSchema:{type:'object',properties:{}}},{name:'cutaste_fixture_new_tool',description:'Added by the runtime',inputSchema:{type:'object',properties:{}}}]};
    else if(req.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({status:'ready',version,name:req.params?.name})}]};
    else result={};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
  }
} else process.stdout.write(JSON.stringify({version,args}));
`;
}

async function writePackage(path, version, compatibility = COMPATIBILITY, { broken = false, universal = false } = {}) {
  await mkdir(path, { recursive: true });
  const supportedPlatforms=['linux-x64','darwin-arm64','darwin-x64'];
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'cutaste', version, os:universal?['linux','darwin']:['linux'], cpu:universal?['x64','arm64']:['x64'], ...(universal?{supportedPlatforms}:{}), ...(compatibility ? { cutasteUpdate: compatibility } : {}) }));
  await mkdir(join(path, 'bin'), { recursive: true });
  await writeFile(join(path, 'bin/cutaste.mjs'), '// Fixture core entry point\n');
  for (const host of ['codex', 'claude-code']) {
    const plugin = join(path, 'plugins', host, 'cutaste');
    const manifest = JSON.stringify({ runtimeKind: 'local-node', platform:universal?'universal':'linux', arch:universal?'universal':'x64', ...(universal?{supportedPlatforms}:{}), requiresPreinstalledNode: true, nodeBundled: false, channel: 'stable' });
    const files = {
      'payload/manifest.json': manifest,
      'supported-platform.json': JSON.stringify({ host, supportedPlatform:universal?'universal':'linux-x64', ...(universal?{supportedPlatforms}:{}), coreManifestSha256: createHash('sha256').update(manifest).digest('hex') }),
      'scripts/launch.sh': '#!/bin/sh\nexec "$CUTASTE_NODE" "${0%/*}/fixture.mjs" "$@"\n',
      'scripts/fixture.mjs': coreFixture(version),
      'scripts/select-core.mjs': '', 'prepare-offline.mjs': '', 'payload/runtime/cutaste.mjs': '',
      'payload/vendor/axe.min.js': '', 'payload/vendor/browser/node_modules/playwright/index.mjs': '',
      'offline/base-template/manifest.json': '{}', 'offline/fontpack/manifest.json': '{}',
    };
    for (const [name, content] of Object.entries(files)) {
      if (broken && name === 'payload/runtime/cutaste.mjs') continue;
      await mkdir(dirname(join(plugin, name)), { recursive: true });
      await writeFile(join(plugin, name), content);
    }
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cutaste-auto-update-test-'));
  const home = join(root, 'data'), prefix = join(root, 'prefix'), bin = join(root, 'bin');
  const registryFile = join(root, 'registry.json'), npmLog = join(root, 'npm.jsonl');
  const children = new Set();
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, 'user'), { recursive: true });
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\n${npmFixture}`);
  await chmod(join(bin, 'npm'), 0o755);
  const env = { ...process.env, HOME: join(root, 'user'), CUTASTE_HOME: home, CUTASTE_INSTALL_DIR: prefix,
    PATH: bin + delimiter + process.env.PATH, FIXTURE_REGISTRY: registryFile, FIXTURE_NPM_LOG: npmLog,
    CUTASTE_AUTO_UPDATE: '1', DISPLAY: ':fixture', WAYLAND_DISPLAY: '', CI: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '', WSL_DISTRO_NAME: '', WSL_INTEROP: '' };
  const registry = { latest: NEXT, packages: {} };
  async function candidate(version, compatibility = COMPATIBILITY, packageOptions = {}) {
    const path = join(root, 'registry', version);
    await writePackage(path, version, compatibility, packageOptions);
    registry.packages[version] = { path, compatibility };
    await writeFile(registryFile, JSON.stringify(registry));
  }
  await candidate(OLD, null);
  await candidate(NEXT, options.compatibility || COMPATIBILITY, options);
  if(!options.fresh) await cp(registry.packages[OLD].path, join(prefix, 'node_modules/cutaste'), { recursive: true });
  function start(args, extra = {}, host = 'codex') {
    const child = spawn(process.execPath, [launch, host, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  }
  async function run(args, extra = {}, host = 'codex') {
    const command = start(args, extra, host);
    command.child.stdin.end();
    const timer = setTimeout(() => command.child.kill('SIGKILL'), 20000);
    try {
      const result = await command.done;
      assert.equal(result.code, 0, `launcher ${args.join(' ')}: ${result.stderr}`);
      return result;
    } finally { clearTimeout(timer); }
  }
  async function prepare(extra = {}, host = 'codex') { return run(['--background'], extra, host); }
  async function check(extra = {}, host = 'codex') { return run(['--update-check'], extra, host); }
  async function current(extra = {}, host = 'codex') { return JSON.parse((await run(['fixture-version'], extra, host)).stdout).version; }
  async function lines(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function calls() { return (await lines(npmLog)).map(line => JSON.parse(line)); }
  async function setRegistry(changes) { Object.assign(registry, changes); await writeFile(registryFile, JSON.stringify(registry)); }
  async function bootstrap() { await prepare({ CUTASTE_AUTO_UPDATE: '0' }); }
  async function daemon(mode = 'busy') {
    await writeFile(join(home, 'state/daemon-mode'), mode);
    const source = join(root, 'daemon.mjs');
    await writeFile(source, daemonFixture);
    const child = spawn(process.execPath, [source], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stderr }); });
    });
    await eventually(() => readJson(join(home, 'state/web.json')), value => value?.pid === child.pid, 'test daemon listens');
    return { child, done, mode: value => writeFile(join(home, 'state/daemon-mode'), value) };
  }
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await sleep(100);
    for (const child of children) child.kill('SIGKILL');
    // Detached hook preparation can finish a small state write after its parent
    // exits. Retry deletion for that tail; never kill unrelated user processes.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, home, prefix, env, registry, candidate, setRegistry, start, run, prepare, check, current, calls, lines, bootstrap, daemon,
    active: () => readJson(join(home, 'state/runtime-updates/active.json')) };
}

test('fresh universal baseline initializes both hosts once without a hand-written active selection',async t=>{
  const f=await fixture(t,{fresh:true,universal:true});
  await f.bootstrap();
  assert.equal((await f.active()).version,NEXT);
  await f.prepare({CUTASTE_AUTO_UPDATE:'0'},'claude-code');
  assert.equal(await f.current({CUTASTE_AUTO_UPDATE:'0'}),NEXT);
  const installs=(await f.calls()).filter(call=>call.args.includes('install'));
  assert.equal(installs.length,1);assert.ok(installs[0].args.includes(`cutaste@${NEXT}`));
  assert.equal((await f.lines(join(f.home,'state/browser-opens.jsonl'))).length,1);
  const setup=await readJson(join(f.home,'state/plugin-setup.json'));
  assert.deepEqual(setup.hosts.sort(),['claude-code','codex']);
});

test('latest for another platform is rejected before downloading and leaves the active core unchanged',async t=>{
  const f=await fixture(t);
  await f.bootstrap();
  const file=join(f.registry.packages[NEXT].path,'package.json');
  const pkg=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...pkg,os:['darwin'],cpu:['arm64']}));
  await f.check();
  assert.equal((await f.active()).version,OLD);
  assert.equal((await f.calls()).filter(call=>call.args.includes('install')).length,0);
  const check=await readJson(join(f.home,'state/runtime-updates/check.json'));
  assert.equal(check.status,'incompatible');
  assert.match(check.message,/does not declare support for/);
});

test('latest is resolved once, installed by exact version, and used without reopening the page', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  assert.equal((await f.lines(join(f.home, 'state/browser-opens.jsonl'))).length, 1);
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  const calls = await f.calls();
  const installs = calls.filter(call => call.args.includes('install'));
  assert.equal(installs.length, 1);
  assert.ok(installs[0].args.includes(`cutaste@${NEXT}`));
  assert.ok(!installs[0].args.includes('cutaste@latest'));
  assert.ok(installs[0].args.includes('--ignore-scripts'));
  assert.equal((await f.active()).version, NEXT);
  assert.equal((await f.lines(join(f.home, 'state/browser-opens.jsonl'))).length, 1);
  const before = calls.length;
  await f.check();
  assert.equal((await f.calls()).length, before, 'the second session must respect the daily registry check interval');
});

test('offline registry does not prevent the already installed version from working', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.setRegistry({ offline: true });
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 0);
});

test('a failed candidate download leaves the previous core usable', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.setRegistry({ installFailure: true });
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
  assert.notEqual((await f.active())?.version, NEXT);
});

test('the next daily check can move to a later stable release', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  await f.candidate('0.1.2');
  await f.setRegistry({ latest: '0.1.2' });
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT, 'latest changes alone must not bypass the daily interval');
  const checkFile = join(f.home, 'state/runtime-updates/check.json');
  const checkpoint = await readJson(checkFile);
  assert.ok(checkpoint, 'the check timestamp is persisted across launcher processes');
  await writeFile(checkFile, JSON.stringify({ ...checkpoint, checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), '0.1.2');
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 2);
  assert.equal((await f.lines(join(f.home, 'state/browser-opens.jsonl'))).length, 1);
});

test('disabled automatic updates do not contact npm', async t => {
  const f = await fixture(t);
  await f.prepare({ CUTASTE_AUTO_UPDATE: '0' });
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.deepEqual(await f.calls(), []);
});

test('a normal warm SessionStart checks in the background while preserving hook output', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.setRegistry({ delay: 150 });
  const event = f.start(['hook', 'SessionStart']);
  event.child.stdin.end(JSON.stringify({ session_id: 'fixture-session' }));
  const completed = await event.done;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).hookSpecificOutput.additionalContext, `core ${OLD}`);
  await eventually(f.active, value => value?.version === NEXT, 'normal SessionStart automatically installs the stable update');
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  assert.equal((await f.lines(join(f.home, 'state/browser-opens.jsonl'))).length, 1);
});

test('concurrent Codex and Claude installations select and install one shared version', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.setRegistry({ delay: 100 });
  const secondPrefix = join(f.root, 'claude-prefix');
  await cp(join(f.prefix, 'node_modules/cutaste'), join(secondPrefix, 'node_modules/cutaste'), { recursive: true });
  await Promise.all([f.check(), f.check({ CUTASTE_INSTALL_DIR: secondPrefix }, 'claude-code')]);
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0', CUTASTE_INSTALL_DIR: secondPrefix }, 'claude-code'), NEXT);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
  assert.equal((await f.lines(join(f.home, 'state/browser-opens.jsonl'))).length, 1);
});

for (const [name, options] of [['incomplete package', { broken: true }], ['incompatible update protocol', { compatibility: { ...COMPATIBILITY, launcherProtocol: 999 } }], ['incompatible data schema', { compatibility: { ...COMPATIBILITY, dataSchema: 999 } }], ['incompatible MCP contract', { compatibility: { ...COMPATIBILITY, mcpContract: 999 } }]]) {
  test(`${name} is not activated and the previous runtime remains usable`, async t => {
    const f = await fixture(t, options);
    await f.bootstrap();
    await f.check();
    assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
    assert.notEqual((await f.active())?.version, NEXT);
  });
}

test('a lower version behind latest never downgrades the installed runtime', async t => {
  const f = await fixture(t);
  await f.candidate('0.0.9');
  await f.setRegistry({ latest: '0.0.9' });
  await f.bootstrap();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 0);
});

test('a running command keeps its version and blocks activation until it finishes', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const held = f.start(['fixture-hold'], { CUTASTE_AUTO_UPDATE: '0' });
  held.child.stdin.end();
  await eventually(() => readJson(join(f.home, 'state/hold-ready.json')), value => value?.version === OLD, 'old core command starts');
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.notEqual((await f.active())?.version, NEXT);
  await writeFile(join(f.home, 'state/hold-release'), 'release');
  const completed = await held.done;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).version, OLD);
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

async function openMcp(f, extra = {}) {
  const process = f.start(['mcp'], { CUTASTE_AUTO_UPDATE: '0', ...extra });
  const lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
  const pending = new Map(); let id = 0;
  lines.on('line', line => {
    const message = JSON.parse(line), waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  });
  async function request(method, params) {
    const next = ++id;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`MCP ${method} timed out: ${process.output().stderr}`)); }, 5000);
      pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); } });
    });
    process.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    return answer;
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' } });
  process.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  async function version() {
    const answer = await request('tools/call', { name: 'cutaste_status', arguments: {} });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return JSON.parse(answer.result.content[0].text).version;
  }
  await eventually(version, value => value === OLD, 'MCP starts the old runtime');
  return { request, version, close: async () => { process.child.stdin.end(); await process.done; lines.close(); } };
}

test('a connected MCP retains its backend and holds the shared active version', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const mcp = await openMcp(f);
  await f.check();
  assert.equal(await mcp.version(), OLD);
  assert.notEqual((await f.active())?.version, NEXT);
  await mcp.close();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
});

test('a busy daemon defers activation, then the authenticated idle gate permits a switch', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const daemon = await f.daemon('busy');
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.doesNotThrow(() => process.kill(daemon.child.pid, 0));
  const pending = await readJson(join(f.home, 'state/runtime-updates/pending.json'));
  assert.equal(pending.version, NEXT, 'the verified download is retained while the daemon is busy');
  await daemon.mode('ready');
  await f.check();
  assert.equal((await daemon.done).code, 0);
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  const requests = (await f.lines(join(f.home, 'state/daemon-requests.jsonl'))).map(JSON.parse);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === 'POST' && request.path === '/_ctl/prepare-update' && request.authenticated));
  assert.ok(requests.every(request => request.body.version === NEXT));
  assert.deepEqual(requests[0].body.compatibility, COMPATIBILITY);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

test('an older daemon without an update gate is never forcibly terminated', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const daemon = await f.daemon('legacy');
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.doesNotThrow(() => process.kill(daemon.child.pid, 0));
  daemon.child.kill('SIGTERM');
  await daemon.done;
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
});

test('a durable background job holds the runtime even after all client processes exit', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const file = join(f.home, 'jobs/fixture-job/job.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ id: 'fixture-job', status: 'running' }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  await writeFile(file, JSON.stringify({ id: 'fixture-job', status: 'completed' }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
});

test('an evaluation ticket keeps its version while the coding assistant works outside Cutaste', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const session = '01111111-1111-4111-8111-111111111111';
  const ticket = '02222222-2222-4222-8222-222222222222';
  const sessionFile = join(f.home, 'assistant-eval/sessions', `${session}.json`);
  const reportFile = join(f.home, 'assistant-eval/reports', `${ticket}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ id: session, tickets: [ticket] }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD, 'unsubmitted tickets are active even without a local daemon');
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify({ state: 'running' }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  await writeFile(reportFile, JSON.stringify({ state: 'completed' }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

test('MCP retains its declared tool contract rather than exposing unreviewed runtime tools', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const mcp = await openMcp(f);
  const response = await mcp.request('tools/list', {});
  assert.equal(response.result.tools.length, 10);
  assert.ok(response.result.tools.some(tool => tool.name === 'cutaste_status'));
  assert.ok(!response.result.tools.some(tool => tool.name === 'cutaste_fixture_new_tool'));
  const called = await mcp.request('tools/call', { name: 'cutaste_fixture_new_tool', arguments: {} });
  assert.equal(called.error?.code, -32602, JSON.stringify(called));
  await mcp.close();
});

test('a complete-looking package with a broken executable is rejected before activation', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const broken = join(f.registry.packages[NEXT].path, 'plugins/codex/cutaste/scripts/fixture.mjs');
  await writeFile(broken, 'const invalid = ;\n');
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.notEqual((await f.active())?.version, NEXT);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

test('an abandoned download lock without an owner is recovered on a later check', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const lock = join(f.home, 'state/runtime-updates/download.lock');
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  await f.check();
  assert.equal(await stat(lock).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error)), undefined);
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

test('MCP connects to the current runtime before a slow npm update finishes', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.setRegistry({ delay: 1500 });
  const mcp = await openMcp(f, { CUTASTE_AUTO_UPDATE: '1' });
  assert.equal(await mcp.version(), OLD);
  const completedDownloads = (await f.lines(join(f.root, 'npm.jsonl.done'))).map(JSON.parse).filter(call => call.args.includes('install'));
  assert.equal(completedDownloads.length, 0, 'MCP must be usable before the background installation completes');
  await eventually(() => readJson(join(f.home, 'state/runtime-updates/pending.json')), value => value?.version === NEXT, 'the background download completes without disconnecting MCP');
  assert.equal(await mcp.version(), OLD);
  await mcp.close();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
});

test('a partially applied data migration blocks activation without a running daemon', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const migration = join(f.home, 'me/evolve/check-migration.partial.json');
  await mkdir(dirname(migration), { recursive: true });
  await writeFile(migration, JSON.stringify({ status: 'partial' }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  await rm(migration);
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
});

test('versioned evaluation waits for both visual and requirement judgments before switching', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  await f.candidate('0.1.2');
  await f.setRegistry({ latest: '0.1.2' });
  const checkFile = join(f.home, 'state/runtime-updates/check.json');
  await writeFile(checkFile, JSON.stringify({ ...(await readJson(checkFile)), checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
  const session = '03333333-3333-4333-8333-333333333333';
  const ticket = '04444444-4444-4444-8444-444444444444';
  const sessionFile = join(f.home, 'assistant-eval/sessions', `${session}.json`);
  const reportFile = join(f.home, 'assistant-eval/reports', `${ticket}.json`);
  await mkdir(dirname(sessionFile), { recursive: true });
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ id: session, coreVersion: NEXT, tickets: [ticket] }));
  await writeFile(reportFile, JSON.stringify({ state: 'completed', expectedJudgments: ['visual', 'requirement'] }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT, 'artifact checking is complete but scoring is not');
  assert.equal((await readJson(join(f.home, 'state/runtime-updates/pending.json'))).version, '0.1.2');
  const visual = join(f.home, 'assistant-eval/visual-judgments', `${ticket}.json`);
  await mkdir(dirname(visual), { recursive: true });
  await writeFile(visual, JSON.stringify({ ticket, score: 81 }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT, 'the missing requirement judgment still holds the version');
  const requirement = join(f.home, 'assistant-eval/requirement-judgments', `${ticket}.json`);
  await mkdir(dirname(requirement), { recursive: true });
  await writeFile(requirement, JSON.stringify({ ticket, score: 92 }));
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), '0.1.2');
});

test('a staged package damaged after download is rechecked and never activated', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const held = f.start(['fixture-hold'], { CUTASTE_AUTO_UPDATE: '0' });
  held.child.stdin.end();
  await eventually(() => readJson(join(f.home, 'state/hold-ready.json')), value => value?.version === OLD, 'old command holds the version');
  await f.check();
  const pending = await readJson(join(f.home, 'state/runtime-updates/pending.json'));
  assert.equal(pending.version, NEXT);
  await writeFile(join(pending.packageRoot, 'plugins/codex/cutaste/scripts/fixture.mjs'), 'throw new Error("damaged after staging");\n');
  await writeFile(join(f.home, 'state/hold-release'), 'release');
  assert.equal((await held.done).code, 0);
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), OLD);
  assert.equal((await f.active()).version, OLD);
  assert.equal((await readJson(join(f.home, 'state/runtime-updates/check.json'))).status, 'failed');
  assert.equal((await f.calls()).filter(call => call.args.includes('install')).length, 1);
});

test('adopting the old installation cannot replace a newer live runtime lease', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  const held = f.start(['fixture-hold'], { CUTASTE_AUTO_UPDATE: '0' });
  held.child.stdin.end();
  await eventually(() => readJson(join(f.home, 'state/hold-ready.json')), value => value?.version === NEXT, 'newer runtime acquires a real command lease');
  const activeFile = join(f.home, 'state/runtime-updates/active.json');
  const active = await readJson(activeFile);
  // Simulate a missing selection record during bootstrap/recovery. The old
  // prefix is still present, but a real newer-version command remains alive.
  await rm(activeFile);
  const oldAttempt = f.start(['fixture-version'], { CUTASTE_AUTO_UPDATE: '0' });
  oldAttempt.child.stdin.end();
  const rejected = await oldAttempt.done;
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Another Cutaste version is running/);
  assert.equal(await f.active(), undefined, 'bootstrap must not create an old-version active record');
  assert.equal(rejected.stdout, '');
  await writeFile(activeFile, JSON.stringify(active));
  await writeFile(join(f.home, 'state/hold-release'), 'release');
  const completed = await held.done;
  assert.equal(completed.code, 0);
  assert.equal(JSON.parse(completed.stdout).version, NEXT);
});

test('the managed CLI preserves custom directories without environment variables and allows overrides', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.check();
  assert.equal(await f.current({ CUTASTE_AUTO_UPDATE: '0' }), NEXT);
  // A surrounding user's CommonJS package must not change the launcher's mode.
  await writeFile(join(f.prefix, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const clean = { ...f.env, CUTASTE_AUTO_UPDATE: '0' };
  delete clean.CUTASTE_HOME;
  delete clean.TASTE_HOME;
  delete clean.CUTASTE_INSTALL_DIR;
  async function invoke(extra = {}) {
    const child = spawn(join(f.prefix, 'bin/cutaste'), ['fixture-version'], { env: { ...clean, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout).version;
    } finally { clearTimeout(timer); }
  }
  assert.equal(await invoke(), NEXT, 'the wrapper remembers the configured installation and data directories');
  const other = await fixture(t);
  await other.bootstrap();
  assert.equal(await invoke({ CUTASTE_HOME: other.home, CUTASTE_INSTALL_DIR: other.prefix }), OLD, 'explicit caller directory overrides remain authoritative');
});
