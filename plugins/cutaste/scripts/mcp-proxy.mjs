// This proxy only keeps MCP available while npm downloads the official runtime.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { VERSION, background, ensureInstalled, delay, installationState, officialEnvironment, officialLauncher, preparationPath, report, sanitized, scripts, validPackage } from './runtime.mjs';

import { acquireRuntime, selectInstalled } from './updates.mjs';

export async function serve(config) {
  const publicTools = JSON.parse(await readFile(join(scripts, 'tools.json'), 'utf8'));
  const pending = new Map();
  const requestIds = new Map();
  let releaseRuntime, sequence = 0, backend, initializeTimer, closed = false, clientInitialized = false, phase = 'preparing', failure;
  let resolveClient;
  const clientReady = new Promise(resolve => { resolveClient = resolve; });
  let clientParams;
  const send = value => { if (!closed) process.stdout.write(JSON.stringify(value) + '\n'); };
  const response = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const backendSend = value => { if (backend?.stdin.writable) backend.stdin.write(JSON.stringify(value) + '\n'); };
  const originalKey = id => JSON.stringify([typeof id, id]);
  const fail = message => {
    clearTimeout(initializeTimer);
    phase = 'failed'; failure = sanitized(message); report(failure);
    for (const original of pending.values()) error(original, -32000, failure);
    pending.clear(); requestIds.clear();
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) { error(null, -32600, 'MCP message exceeds 4 MiB.'); return; }
    let request;
    try { request = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON.'); return; }
    if (!request || request.jsonrpc !== '2.0' || typeof request !== 'object') { error(request?.id ?? null, -32600, 'Invalid request.'); return; }
    if (!request.method) { if (phase === 'runtime-ready') backendSend(request); return; }
    if (request.method === 'initialize') {
      if (clientInitialized) { error(request.id, -32600, 'MCP is already initialized.'); return; }
      clientInitialized = true; clientParams = request.params || {};
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      const protocolVersion = supported.includes(clientParams.protocolVersion) ? clientParams.protocolVersion : '2025-06-18';
      clientParams = { ...clientParams, protocolVersion };
      response(request.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cutaste', version: '0.2.2' },
        instructions: 'Cutaste prepares its compatible local runtime automatically. Tool calls report preparation until the official MCP is ready; this does not confirm that the local page has started.' });
      resolveClient(); return;
    }
    if (request.method === 'ping') { if (request.id !== undefined) response(request.id, {}); return; }
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'notifications/cancelled') {
      const id = requestIds.get(originalKey(request.params?.requestId));
      if (id) backendSend({ ...request, params: { ...request.params, requestId: id } });
      return;
    }
    if (request.id === undefined) { if (phase === 'runtime-ready') backendSend(request); return; }
    if (!clientInitialized) { error(request.id, -32000, 'Initialize MCP first.'); return; }
    if (request.method === 'tools/list') { response(request.id, publicTools); return; }
    if (request.method !== 'tools/call') { error(request.id, -32601, 'Method not found.'); return; }
    if (!publicTools.tools.some(tool => tool.name === request.params?.name)) { error(request.id, -32602, 'Unknown Cutaste tool.'); return; }
    if (phase !== 'runtime-ready') {
      response(request.id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: phase,
        package: `cutaste@${config.version || VERSION}`, mcpReady: false, retryable: phase !== 'failed',
        message: failure || (phase === 'initializing-runtime' ? 'The npm package is ready; automatic local setup is initializing the benchmark and local page.' : phase === 'starting-runtime' ? 'Automatic local setup finished; the official MCP is connecting.'
          : 'The local package is preparing automatically. The first download can take several minutes. No tool operation was executed; try again after preparation.') }) }] });
      return;
    }
    const id = `cutaste-proxy:${++sequence}`;
    pending.set(id, request.id); requestIds.set(originalKey(request.id), id);
    backendSend({ ...request, id });
  });
  const stop = () => {
    if (closed) return;
    closed = true; resolveClient(); input.close();
    clearTimeout(initializeTimer);
    backend?.kill('SIGTERM');
  };
  input.once('close', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);

  try {
    const started = Date.now();
    const worker = background(config);
    let workerStopped = false, workerCode;
    worker.once('error', () => { workerStopped = true; workerCode = 1; });
    worker.once('close', code => { workerStopped = true; workerCode = code; });
    report('Preparing Cutaste and its local setup in the background; MCP discovery is available now.');
    while (!closed && !workerStopped) {
      await selectInstalled(config);
      if (await validPackage(config.packageRoot, config.version)) phase = 'initializing-runtime';
      else {
        const state = await installationState(config);
        if (state?.status === 'failed' && (Date.parse(state.updatedAt) >= started || Date.now() - Date.parse(state.updatedAt) < 60_000)) throw new Error(state.message);
      }
      if (Date.now() - started > 15 * 60_000) throw new Error('Runtime preparation exceeded 15 minutes; reopening the plugin retries automatically.');
      await delay(250);
    }
    if (closed) return;
    if (workerCode !== 0) {
      const state = await installationState(config);
      throw new Error(state?.status === 'failed' ? state.message : 'Local preparation stopped before the package and setup were ready. Check CUTASTE_INSTALL_DIR permissions and local npm availability.');
    }
    const prepared = JSON.parse(await readFile(preparationPath(config), 'utf8'));
    if (prepared.status === 'degraded') report(`Automatic setup is degraded: ${JSON.stringify(prepared.problems)}. The official MCP will report its actual available state.`);
    await clientReady;
    if (closed) return;
    await ensureInstalled(config);
    releaseRuntime = await acquireRuntime(config, 'mcp');
    if (closed) { await releaseRuntime(); return; }
    phase = 'starting-runtime';
    backend = spawn('/bin/sh', [officialLauncher(config), 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: officialEnvironment(config),
    });
    backend.stdin.on('error', () => {});
    const diagnostics = createInterface({ input: backend.stderr, crlfDelay: Infinity });
    diagnostics.on('line', line => process.stderr.write(sanitized(line) + '\n'));
    backend.once('error', () => { void releaseRuntime?.(); fail('The installed MCP runtime could not start.'); });
    const output = createInterface({ input: backend.stdout, crlfDelay: Infinity });
    output.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { fail('The installed MCP emitted an invalid protocol message.'); backend.kill(); return; }
      if (message.id === 'cutaste-initialize') {
        clearTimeout(initializeTimer);
        if (message.error || !message.result?.capabilities?.tools) { fail('The installed MCP failed initialization.'); backend.kill(); return; }
        backendSend({ jsonrpc: '2.0', method: 'notifications/initialized' });
        phase = 'runtime-ready';
        return;
      }
      if (pending.has(message.id)) {
        const original = pending.get(message.id); pending.delete(message.id); requestIds.delete(originalKey(original));
        send({ ...message, id: original });
      } else send(message);
    });
    backend.once('close', code => { void releaseRuntime?.(); if (!closed) fail(`The installed MCP stopped (exit ${code ?? 'signal'}). Reopen the plugin to reconnect.`); });
    initializeTimer = setTimeout(() => { fail('The installed MCP did not initialize within 30 seconds. Reopen the plugin to reconnect.'); backend.kill('SIGTERM'); }, 30_000);
    backendSend({ jsonrpc: '2.0', id: 'cutaste-initialize', method: 'initialize', params: clientParams });
  } catch (error) { if (!closed) fail(error.message); }
}
