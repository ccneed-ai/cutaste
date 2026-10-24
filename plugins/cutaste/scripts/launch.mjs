#!/usr/bin/env node
import { background, configuration, ensureInstalled, prepareRuntime, readHookInput, record, report, runOfficial, validPackage } from './runtime.mjs';

const [host, ...args] = process.argv.slice(2);
let config;
try {
  config = configuration(host);
  if (args[0] === '--background') {
    const forwarded = args.slice(1);
    const input = forwarded[0] === 'hook' ? await readHookInput() : undefined;
    if (!forwarded.length || forwarded[0] === 'hook') await prepareRuntime(config);
    else await ensureInstalled(config, { forceRetry: forwarded[0] === 'setup' });
    if (forwarded.length) {
      const code = await runOfficial(config, forwarded, input);
      if (code) await record(config, 'hook-failed', `The deferred ${forwarded[1] || 'hook'} exited with code ${code}.`);
    }
  } else if (args[0] === 'mcp') {
    const { serve } = await import('./mcp-proxy.mjs');
    await serve(config);
  } else if (args[0] === 'hook') {
    const input = await readHookInput();
    if (await validPackage(config.packageRoot)) process.exitCode = await runOfficial(config, args, input);
    else {
      background(config, args, input);
      if (args[1] === 'SessionStart') report('Preparing the local npm package in the background; this session event will be delivered after preparation.');
    }
  } else {
    if (!await validPackage(config.packageRoot)) report('Preparing cutaste@0.1.0; the first download can take several minutes.');
    await ensureInstalled(config, { forceRetry: args[0] === 'setup' });
    process.exitCode = await runOfficial(config, args);
  }
} catch (error) {
  if (args[0] !== 'hook' || args[1] === 'SessionStart') report(error.message);
  if (config && args[0] === '--background' && error.code !== 'CUTASTE_COOLDOWN') await record(config, 'failed', error.message).catch(() => {});
  // Capture hooks must not block the user's coding task when a dependency is unavailable.
  process.exitCode = args[0] === 'hook' ? 0 : 1;
}
