#!/usr/bin/env node
import { background, configuration, ensureInstalled, hasSetupRecord, prepareRuntime, readHookInput, record, report, runOfficial, validPackage } from './runtime.mjs';

import { checkForUpdates, scheduleUpdate, selectInstalled } from './updates.mjs';

const [host, ...args] = process.argv.slice(2);
let config;
try {
  config = configuration(host);
  await selectInstalled(config);
  if (args[0] === '--update-check') {
    await checkForUpdates(config);
  } else if (args[0] === '--background') {
    const forwarded = args.slice(1);
    const input = forwarded[0] === 'hook' ? await readHookInput() : undefined;
    if (!forwarded.length || forwarded[0] === 'hook') await prepareRuntime(config);
    else await ensureInstalled(config, { forceRetry: forwarded[0] === 'setup' });
    if (forwarded.length) {
      const code = await runOfficial(config, forwarded, input);
      if (code) await record(config, 'hook-failed', `The deferred ${forwarded[1] || 'hook'} exited with code ${code}.`);
    }
    scheduleUpdate(config);
  } else if (args[0] === 'mcp') {
    const { serve } = await import('./mcp-proxy.mjs');
    await serve(config);
  } else if (args[0] === 'hook') {
    const input = await readHookInput();
    if (args[1] === 'SessionStart' && !await hasSetupRecord()) {
      // Preparation owns first-run browser opening. The bundled hook's older auto-setup
      // must not initialize the directory first with --no-open when npm is already cached.
      background(config, args, input);
    } else if (await validPackage(config.packageRoot, config.version)) {
      // Warm hooks must return their additionalContext to the host; only preparation detaches.
      if (args[1] === 'SessionStart') background(config);
      process.exitCode = await runOfficial(config, args, input);
    }
    else {
      background(config, args, input);
      if (args[1] === 'SessionStart') report('Preparing the local npm package in the background; this session event will be delivered after preparation.');
    }
  } else {
    if (!await validPackage(config.packageRoot, config.version)) report('Preparing the Cutaste runtime; the first download can take several minutes.');
    await ensureInstalled(config, { forceRetry: args[0] === 'setup' });
    scheduleUpdate(config);
    process.exitCode = await runOfficial(config, args);
  }
} catch (error) {
  if (args[0] !== 'hook' || args[1] === 'SessionStart') report(error.message);
  if (config && args[0] === '--background' && error.code !== 'CUTASTE_COOLDOWN') await record(config, 'failed', error.message).catch(() => {});
  // Capture hooks must not block the user's coding task when a dependency is unavailable.
  process.exitCode = args[0] === 'hook' ? 0 : 1;
}
