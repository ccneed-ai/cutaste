import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { hasDesktop } from '../plugins/cutaste/scripts/first-page.mjs';
import { supportedRuntime, packageMatchesPlatform } from '../plugins/cutaste/scripts/runtime.mjs';

const exec = promisify(execFile);
const runtime = new URL('../plugins/cutaste/scripts/runtime.mjs', import.meta.url).href;
const compatibility = { launcherProtocol:1, dataSchema:1, mcpContract:1 };
const supportedPlatforms = ['linux-x64','darwin-arm64','darwin-x64'];

async function fixture(t, platform='darwin', arch='arm64', universal=false) {
  const root=await mkdtemp(join(tmpdir(),'cutaste-platform-test-'));
  const prefix=join(root,'private install'), home=join(root,'data'), packageRoot=join(prefix,'node_modules/cutaste');
  await mkdir(packageRoot,{recursive:true});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'cutaste',version:'0.1.1',os:universal?['linux','darwin']:[platform],cpu:universal?['x64','arm64']:[arch],...(universal?{supportedPlatforms}:{}),cutasteUpdate:compatibility}));
  for(const host of ['codex','claude-code']) {
    const plugin=join(packageRoot,'plugins',host,'cutaste');
    const manifest=JSON.stringify({runtimeKind:'local-node',platform:universal?'universal':platform,arch:universal?'universal':arch,...(universal?{supportedPlatforms}:{}),requiresPreinstalledNode:true,nodeBundled:false,channel:'stable'});
    const files={
      'payload/manifest.json':manifest,
      'supported-platform.json':JSON.stringify({host,supportedPlatform:universal?'universal':`${platform}-${arch}`,...(universal?{supportedPlatforms}:{}),coreManifestSha256:createHash('sha256').update(manifest).digest('hex')}),
      'scripts/launch.sh':"#!/bin/sh\nprintf '%s\\n' '0.1.1'\n", 'scripts/select-core.mjs':'', 'prepare-offline.mjs':'',
      'payload/runtime/cutaste.mjs':'', 'payload/vendor/axe.min.js':'', 'payload/vendor/browser/node_modules/playwright/index.mjs':'',
      'offline/base-template/manifest.json':'{}', 'offline/fontpack/manifest.json':'{}',
    };
    for(const [name,contents] of Object.entries(files)) {
      await mkdir(dirname(join(plugin,name)),{recursive:true});await writeFile(join(plugin,name),contents);
    }
  }
  await mkdir(join(packageRoot,'bin'));await writeFile(join(packageRoot,'bin/cutaste.mjs'),'// fixture\n');
  t.after(()=>rm(root,{recursive:true,force:true}));
  // Simulate Node's host identifiers only in an isolated test process. Production
  // runtime selection has no environment override for its actual platform.
  async function run(code, hostPlatform=platform, hostArch=arch,extra={}) {
    const source=`Object.defineProperty(process,'platform',{value:${JSON.stringify(hostPlatform)}});Object.defineProperty(process,'arch',{value:${JSON.stringify(hostArch)}});const runtime=await import(${JSON.stringify(runtime)});${code}`;
    const result=await exec(process.execPath,['--input-type=module','-e',source],{timeout:10000,env:{...process.env,CUTASTE_AUTO_UPDATE:'0',CUTASTE_HOME:home,CUTASTE_INSTALL_DIR:prefix,CODEX_HOME:join(root,'profiles/custom codex'),...extra}});
    return JSON.parse(result.stdout);
  }
  return {root,prefix,home,packageRoot,run};
}

test('supported launcher platforms are explicit and package declarations must match',()=>{
  for(const [platform,arch] of [['linux','x64'],['darwin','arm64'],['darwin','x64']]) {
    assert.equal(supportedRuntime(platform,arch),true);
    assert.equal(packageMatchesPlatform({os:[platform],cpu:[arch]},platform,arch),true);
  }
  for(const [platform,arch] of [['win32','x64'],['linux','arm64'],['darwin','ia32']]) assert.equal(supportedRuntime(platform,arch),false);
  assert.equal(packageMatchesPlatform({os:['linux'],cpu:['x64']},'darwin','arm64'),false);
  assert.equal(packageMatchesPlatform({},'darwin','arm64'),false);
  assert.equal(packageMatchesPlatform({os:['darwin','!darwin'],cpu:['arm64']},'darwin','arm64'),false);
});

test('Mac desktop can open without X11 variables while SSH and CI never open',()=>{
  assert.equal(hasDesktop({},'darwin'),true);
  for(const name of ['SSH_CONNECTION','SSH_CLIENT','SSH_TTY','CI']) assert.equal(hasDesktop({[name]:'yes'},'darwin'),false);
});

for(const [platform,arch] of [['linux','x64'],['darwin','arm64'],['darwin','x64']]) {
  test(`actual host ${platform}-${arch} accepts its matching package and rejects another host`,async t=>{
    const f=await fixture(t,platform,arch);
    const check=`process.stdout.write(JSON.stringify(await runtime.validPackage(${JSON.stringify(f.packageRoot)},'0.1.1')));`;
    assert.equal(await f.run(check),true);
    assert.equal(await f.run(check,platform==='linux'?'darwin':'linux',arch),false);
  });
}

test('supported-platform metadata cannot contradict the core manifest or host',async t=>{
  const f=await fixture(t);
  const file=join(f.packageRoot,'plugins/codex/cutaste/supported-platform.json');
  const original=JSON.parse(await readFile(file,'utf8'));
  const check=`process.stdout.write(JSON.stringify(await runtime.validPackage(${JSON.stringify(f.packageRoot)},'0.1.1')));`;
  await writeFile(file,JSON.stringify({...original,supportedPlatform:'linux-x64'}));assert.equal(await f.run(check),false);
  await writeFile(file,JSON.stringify({...original,host:'claude-code'}));assert.equal(await f.run(check),false);
  await writeFile(file,JSON.stringify({...original,coreManifestSha256:'wrong'}));assert.equal(await f.run(check),false);
});

test('Mac adopts a compatible installed candidate without a hand-written active record',async t=>{
  const f=await fixture(t);
  const result=await f.run(`const config=runtime.configuration('codex');await runtime.ensureInstalled(config);process.stdout.write(JSON.stringify({version:config.version,path:config.packageRoot}));`);
  assert.equal(result.version,'0.1.1');assert.equal(result.path,f.packageRoot);
  const active=JSON.parse(await readFile(join(f.home,'state/runtime-updates/active.json'),'utf8'));
  assert.equal(active.version,'0.1.1');
});

test('verified Mac active record supports a custom installation and Codex profile path',async t=>{
  const f=await fixture(t);
  const state=join(f.home,'state/runtime-updates');await mkdir(state,{recursive:true});
  await writeFile(join(state,'active.json'),JSON.stringify({version:'0.1.1',packageRoot:f.packageRoot,compatibility}));
  const value=await f.run(`const config=runtime.configuration('codex');await runtime.ensureInstalled(config);process.stdout.write(JSON.stringify({version:config.version,path:config.packageRoot,profile:process.env.CODEX_HOME}));`);
  assert.equal(value.version,'0.1.1');assert.equal(value.path,f.packageRoot);
  assert.equal(value.profile,join(f.root,'profiles/custom codex'));
  const managed=await readFile(join(f.prefix,'bin/cutaste.mjs'),'utf8');
  assert.ok(managed.includes(JSON.stringify(f.prefix)));assert.ok(managed.includes(JSON.stringify(f.home)));
});

test('one universal package validates all declared hosts and rejects undeclared platform combinations',async t=>{
  const f=await fixture(t,'darwin','arm64',true);
  const check=`process.stdout.write(JSON.stringify(await runtime.validPackage(${JSON.stringify(f.packageRoot)},'0.1.1')));`;
  for(const [platform,arch] of [['linux','x64'],['darwin','arm64'],['darwin','x64']]) assert.equal(await f.run(check,platform,arch),true);
  assert.equal(await f.run(check,'linux','arm64'),false);
  assert.equal(await f.run(check,'win32','x64'),false);
  const file=join(f.packageRoot,'plugins/codex/cutaste/supported-platform.json');
  const manifest=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...manifest,supportedPlatforms:['darwin-arm64']}));
  assert.equal(await f.run(check),false,'universal package and plugin lists must agree');
});

for(const arch of ['arm64','x64']) test(`fresh Mac ${arch} installs universal 0.1.1 and selects it without Linux fallback or manual state`,async t=>{
  const f=await fixture(t,'darwin',arch,true);
  const source=join(f.root,'local-candidate'),bin=join(f.root,'npm-shim'),log=join(f.root,'npm-args.json');
  await cp(f.packageRoot,source,{recursive:true});await rm(f.packageRoot,{recursive:true});await mkdir(bin);
  await writeFile(join(bin,'npm'),`#!${process.execPath}\n(async()=>{const fs=await import('node:fs/promises');const path=await import('node:path');const args=process.argv.slice(2);await fs.writeFile(${JSON.stringify(log)},JSON.stringify(args));const prefix=args[args.indexOf('--prefix')+1];if(!args.includes('cutaste@0.1.1')||args.includes('--force'))process.exit(2);await fs.mkdir(path.join(prefix,'node_modules'),{recursive:true});await fs.cp(${JSON.stringify(source)},path.join(prefix,'node_modules/cutaste'),{recursive:true});})();\n`);
  await chmod(join(bin,'npm'),0o755);
  const value=await f.run(`const config=runtime.configuration('codex');await runtime.ensureInstalled(config);process.stdout.write(JSON.stringify({version:config.version,path:config.packageRoot}));`,'darwin',arch,{PATH:bin+delimiter+process.env.PATH});
  assert.equal(value.version,'0.1.1');assert.equal(value.path,f.packageRoot);
  const args=JSON.parse(await readFile(log,'utf8'));
  assert.ok(args.includes('cutaste@0.1.1'));assert.ok(!args.includes('cutaste@0.1.0'));assert.ok(!args.includes('--force'));
  const active=JSON.parse(await readFile(join(f.home,'state/runtime-updates/active.json'),'utf8'));
  assert.equal(active.version,'0.1.1');
});
