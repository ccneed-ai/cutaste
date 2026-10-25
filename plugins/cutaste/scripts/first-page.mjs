// The native plugin opens the page once for a new data directory, never once per host/version.
// Call these helpers while holding that directory's automatic-setup lock.
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const markerPath = home => join(home, 'state', 'plugin-first-page.json');
export function hasDesktop(env) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CI) return false;
  // Linux desktop/WSLg, or a Windows browser reachable through WSL's launcher.
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || (env.WSL_DISTRO_NAME && env.WSL_INTEROP));
}
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function claimFirstPage(home, env) {
  const file = markerPath(home);
  if (await exists(file)) return { allowOpen: false, outcome: 'already-recorded' };
  // Existing users must not get a surprise tab merely because the plugin was upgraded.
  const existing = ['config.json', 'runtime-location', 'me', 'objects', 'projects', 'state/plugin-setup.json', 'state/plugin-auto-setup.json'];
  let previousInstall = false;
  for (const path of existing) if (await exists(join(home, path))) { previousInstall = true; break; }
  const outcome = previousInstall ? 'skipped-existing-install' : hasDesktop(env) ? 'attempted' : 'skipped-no-desktop';
  const value = { schemaVersion: 1, outcome, at: new Date().toISOString() };
  // Claim before calling the opener. A crash or a partially completed setup must not reopen it.
  try { await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return { allowOpen: false, outcome: 'already-recorded' }; throw error; }
  return { allowOpen: outcome === 'attempted', outcome };
}
export async function finishFirstPage(home, claim, result) {
  if (!claim.allowOpen) return claim;
  const file = markerPath(home);
  const previous = JSON.parse(await readFile(file, 'utf8'));
  const outcome = result?.opened === true ? 'open-requested' : 'not-opened';
  const value = { ...previous, outcome, finishedAt: new Date().toISOString(), url: result?.url };
  const temporary = file + `.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  return { allowOpen: true, outcome };
}
