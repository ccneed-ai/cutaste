import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDesktop } from '../plugins/cutaste/scripts/first-page.mjs';
const exec = promisify(execFile);
const runtime = new URL('../plugins/cutaste/scripts/runtime.mjs', import.meta.url).href;
const launch = fileURLToPath(new URL('../plugins/cutaste/scripts/launch.mjs', import.meta.url));
const fixtureCore = String.raw`
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.CUTASTE_HOME, state = join(home, 'state'), args = process.argv.slice(2);
await mkdir(state, {recursive:true});
const savedFile = join(state,'plugin-setup.json');
let saved; try { saved = JSON.parse(await readFile(savedFile,'utf8')); } catch {}
if(args[0] === 'hook') {
  const first = JSON.parse(await readFile(join(state,'plugin-first-page.json'),'utf8'));
  await writeFile(join(state,'hook-delivered.json'), JSON.stringify({first, event:args[1]}));
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:args[1],additionalContext:'fixture context_tasks and alignment reminder'}}));
  process.exit(0);
}
if(args.includes('--status')) {
  process.stdout.write(JSON.stringify(saved || {status:'not-ready',hosts:[]}));
  process.exit(0);
}
await appendFile(join(state,'setup-calls.jsonl'), JSON.stringify(args)+'\n');
await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_DELAY || 0)));
const opened = !args.includes('--no-open') && process.env.FIXTURE_OPEN_FAIL !== '1';
const attempted = !args.includes('--no-open');
if(attempted) await appendFile(join(state,'browser-attempts.jsonl'), 'open\n');
const host=args[args.indexOf('--host')+1];
const result={status:process.env.FIXTURE_DEGRADED === '1'?'degraded':'ready', hosts:[...new Set([...(saved?.hosts||[]),host])],url:'http://127.0.0.1:43210/',opened,template:'ready',background:'waiting',problems:[]};
await writeFile(savedFile,JSON.stringify(result));
if(process.env.FIXTURE_DAEMON_PORT) await writeFile(join(state,'web.json'),JSON.stringify({pid:Number(process.env.FIXTURE_DAEMON_PID),port:Number(process.env.FIXTURE_DAEMON_PORT),control:'fixture-control',runtimeVersion:'0.1.0'}));
if(process.env.FIXTURE_CRASH === '1') process.exit(1);
process.stdout.write(JSON.stringify(result));
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cutaste-first-page-test-'));
  const home = join(root, 'data');
  const env = {...process.env, CUTASTE_AUTO_UPDATE:'0', HOME:join(root,'user'),CUTASTE_HOME:home,DISPLAY:':fixture',CI:'',SSH_CONNECTION:'',SSH_CLIENT:'',SSH_TTY:'',WAYLAND_DISPLAY:'',WSL_DISTRO_NAME:'',WSL_INTEROP:''};
  let daemon;
  async function stopDaemon() {
    if (!daemon?.listening) return;
    await new Promise((resolve,reject)=>daemon.close(error=>error?reject(error):resolve()));
  }
  async function startDaemon() {
    daemon=createServer((req,res)=>{
      req.resume();
      if(req.method!=='POST'||req.url!=='/_ctl/ping'||req.headers['x-taste-control']!=='fixture-control') {
        res.writeHead(404);res.end('{}');return;
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:true,pid:process.pid,version:'0.1.0'}));
    });
    await new Promise((resolve,reject)=>{daemon.once('error',reject);daemon.listen(0,'127.0.0.1',resolve);});
    env.FIXTURE_DAEMON_PORT=String(daemon.address().port);
    env.FIXTURE_DAEMON_PID=String(process.pid);
  }
  await startDaemon();
  t.after(async()=>{await stopDaemon();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  await mkdir(env.HOME, {recursive:true});
  async function config(host='codex', name='prefix') {
    const prefix=join(root,name), packageRoot=join(prefix,'node_modules/cutaste');
    await mkdir(packageRoot,{recursive:true});
    await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'cutaste',version:'0.1.0',os:['linux'],cpu:['x64']}));
    await mkdir(join(packageRoot,'bin'),{recursive:true});
    await writeFile(join(packageRoot,'bin/cutaste.mjs'),'// fixture');
    for(const platform of ['codex','claude-code']) {
      const plugin=join(packageRoot,'plugins',platform,'cutaste');
      const manifest=JSON.stringify({runtimeKind:'local-node',platform:'linux',arch:'x64',requiresPreinstalledNode:true,nodeBundled:false,channel:'stable'});
      const files={
        'payload/manifest.json':manifest,
        'supported-platform.json':JSON.stringify({host:platform,supportedPlatform:'linux-x64',coreManifestSha256:createHash('sha256').update(manifest).digest('hex')}),
        'scripts/launch.sh':'#!/bin/sh\nexec "$CUTASTE_NODE" "${0%/*}/fixture.mjs" "$@"\n',
        'scripts/fixture.mjs':fixtureCore,
        'scripts/select-core.mjs':'', 'prepare-offline.mjs':'', 'payload/runtime/cutaste.mjs':'',
        'payload/vendor/axe.min.js':'', 'payload/vendor/browser/node_modules/playwright/index.mjs':'',
        'offline/base-template/manifest.json':'{}','offline/fontpack/manifest.json':'{}',
      };
      for(const [path,content] of Object.entries(files)){await mkdir(dirname(join(plugin,path)),{recursive:true});await writeFile(join(plugin,path),content);}
    }
    return {host,prefix,control:join(prefix,'.cutaste-plugin'),packageRoot};
  }
  async function run(config, extra={}) {
    const code=`import {prepareRuntime} from ${JSON.stringify(runtime)}; process.stdout.write(JSON.stringify(await prepareRuntime(${JSON.stringify(config)})));`;
    const result=await exec(process.execPath,['--input-type=module','-e',code],{env:{...env,...extra},timeout:20000});
    return JSON.parse(result.stdout);
  }
  async function lines(name) { try {return (await readFile(join(home,'state',name),'utf8')).trim().split('\n').filter(Boolean);} catch(error){if(error.code==='ENOENT')return [];throw error;} }
  return {root,home,env,config,run,lines,startDaemon,stopDaemon};
}

test('desktop detection excludes SSH/CI/headless and permits desktop or WSL browser',()=>{
  assert.equal(hasDesktop({},'linux'),false);
  assert.equal(hasDesktop({BROWSER:'xdg-open'},'linux'),false);
  assert.equal(hasDesktop({DISPLAY:':0'},'linux'),true);
  assert.equal(hasDesktop({WAYLAND_DISPLAY:'wayland-0'},'linux'),true);
  assert.equal(hasDesktop({WSL_DISTRO_NAME:'Ubuntu',WSL_INTEROP:'/run/WSL/1_interop'},'linux'),true);
  for(const name of ['SSH_CONNECTION','SSH_CLIENT','SSH_TTY','CI'])assert.equal(hasDesktop({DISPLAY:':0',[name]:'yes'},'linux'),false);
});

test('fresh install opens once, repeated starts and the other host never reopen',async t=>{
  const f=await fixture(t), first=await f.config();
  const a=await f.run(first);assert.equal(a.opened,true);assert.equal(a.firstPage,'open-requested');
  const b=await f.run(first);assert.equal(b.opened,false);
  await f.run(await f.config('claude-code','other-prefix'));
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
  assert.equal((await f.lines('setup-calls.jsonl')).length,2);
});

test('saved ready status restarts a stopped local service without opening another browser tab',async t=>{
  const f=await fixture(t),config=await f.config();
  await f.run(config);
  assert.equal((await f.lines('setup-calls.jsonl')).length,1);
  const old=JSON.parse(await readFile(join(f.home,'state/web.json'),'utf8'));
  await f.stopDaemon();
  await f.startDaemon();
  // The persisted ready record still points at the closed listener. setup must
  // refresh it instead of trusting the historical installation result.
  const stale=JSON.parse(await readFile(join(f.home,'state/web.json'),'utf8'));
  assert.equal(stale.port,old.port);
  const recovered=await f.run(config);
  assert.equal(recovered.status,'ready');
  assert.equal(recovered.opened,false);
  assert.equal((await f.lines('setup-calls.jsonl')).length,2);
  assert.ok(JSON.parse((await f.lines('setup-calls.jsonl'))[1]).includes('--no-open'));
  const current=JSON.parse(await readFile(join(f.home,'state/web.json'),'utf8'));
  assert.equal(current.port,Number(f.env.FIXTURE_DAEMON_PORT));
  await f.run(config);
  assert.equal((await f.lines('setup-calls.jsonl')).length,2,'the live replacement service does not need repeated setup');
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
});

test('concurrent hosts in different installation prefixes share the once-only claim',async t=>{
  const f=await fixture(t), configs=await Promise.all([f.config('codex','prefix-a'),f.config('claude-code','prefix-b')]);
  await Promise.all(configs.map(c=>f.run(c,{FIXTURE_DELAY:'100'})));
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
  const saved=JSON.parse(await readFile(join(f.home,'state/plugin-setup.json'),'utf8'));
  assert.deepEqual(saved.hosts.sort(),['claude-code','codex']);
});

test('failed browser opening is nonfatal and degraded retries never reopen',async t=>{
  const f=await fixture(t), config=await f.config();
  const a=await f.run(config,{FIXTURE_OPEN_FAIL:'1',FIXTURE_DEGRADED:'1'});
  assert.equal(a.status,'degraded');assert.equal(a.opened,false);assert.equal(a.firstPage,'not-opened');
  const b=await f.run(config);assert.equal(b.status,'ready');assert.equal(b.url,'http://127.0.0.1:43210/');
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
});

test('uncertain setup crash consumes the automatic attempt without suppressing recovery',async t=>{
  const f=await fixture(t),config=await f.config();
  await assert.rejects(f.run(config,{FIXTURE_CRASH:'1'}));
  assert.equal((await f.run(config)).status,'ready');
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
});

test('SSH, CI and no desktop still initialize and expose the URL without opening',async t=>{
  for(const extra of [{SSH_CONNECTION:'remote'},{CI:'true'},{DISPLAY:''}]){
    const f=await fixture(t),config=await f.config();
    const result=await f.run(config,extra);
    assert.equal(result.status,'ready');assert.equal(result.opened,false);assert.equal(result.firstPage,'skipped-no-desktop');assert.equal(result.url,'http://127.0.0.1:43210/');
    await f.run(config); // Opening a later graphical session must not surprise the user.
    assert.equal((await f.lines('browser-attempts.jsonl')).length,0);
  }
});

test('existing installs and unreadable/truncated previous claims never pop up on upgrade',async t=>{
  for(const path of ['config.json','state/plugin-setup.json','runtime-location','state/plugin-first-page.json']){
    const f=await fixture(t),config=await f.config();
    await mkdir(dirname(join(f.home,path)),{recursive:true});
    await writeFile(join(f.home,path),path==='state/plugin-setup.json'?JSON.stringify({status:'degraded',hosts:['codex']}):'');
    assert.equal((await f.run(config)).opened,false);
    assert.equal((await f.lines('browser-attempts.jsonl')).length,0);
  }
});

test('manual setup can still explicitly open the page after an automatic attempt',async t=>{
  const f=await fixture(t),config=await f.config();
  await f.run(config);
  await exec(process.execPath,[launch,'codex','setup','--host','codex','--json'],{env:{...f.env,CUTASTE_INSTALL_DIR:config.prefix},timeout:20000});
  assert.equal((await f.lines('browser-attempts.jsonl')).length,2);
});

test('cached SessionStart prepares first and delivers its hook in the background',async t=>{
  const f=await fixture(t),config=await f.config();
  const event = exec(process.execPath,[launch,'codex','hook','SessionStart'],{env:{...f.env,CUTASTE_INSTALL_DIR:config.prefix},timeout:20000});
  event.child.stdin.end(JSON.stringify({ session_id: 'fixture-only' }));
  await event;
  const deadline=Date.now()+10000;let delivered;
  while(Date.now()<deadline){try{delivered=JSON.parse(await readFile(join(f.home,'state/hook-delivered.json'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.equal(delivered?.event,'SessionStart');assert.equal(delivered.first.outcome,'open-requested');
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
});

test('warm SessionStart preserves additionalContext on stdout and does not reopen',async t=>{
  const f=await fixture(t),config=await f.config();
  await f.run(config);
  const event=exec(process.execPath,[launch,'codex','hook','SessionStart'],{env:{...f.env,CUTASTE_INSTALL_DIR:config.prefix},timeout:20000});
  event.child.stdin.end(JSON.stringify({session_id:'fixture-warm'}));
  const response=JSON.parse((await event).stdout);
  assert.equal(response.hookSpecificOutput.additionalContext,'fixture context_tasks and alignment reminder');
  assert.equal((await f.lines('browser-attempts.jsonl')).length,1);
  // Wait for the independent preparation writer before removing the fixture directory.
  await new Promise(resolve=>setTimeout(resolve,300));
});
