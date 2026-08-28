// Shared test helpers: spawn the real companion against the fake pi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMPANION = path.join(HERE, '..', 'companion', 'pi-delegate.mjs');
export const FAKE_PI = path.join(HERE, 'fake-pi.mjs');

// Run the companion as a black box. Returns { code, stdout, stderr }.
// PI_BIN always points at the fake pi; HOME can be isolated per test.
export function runCompanion(args, { cwd, homedir, stdin, env = {} } = {}) {
  const r = spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    input: stdin,
    env: {
      ...process.env,
      PI_BIN: FAKE_PI,
      HOME: homedir ?? process.env.HOME,
      FAKE_PI_SPEC: '',
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Create a throwaway directory (optionally a git repo) isolated from the
// developer's real workspace. Returns its absolute path.
export function makeTempDir({ git = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-')));
  if (git) {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  }
  return dir;
}

// Read the companion state file of a repo, or null when absent.
export function readState(cwd) {
  const p = path.join(cwd, '.pi-delegate', 'state.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Latest job record from the state file of a repo.
export function latestJob(cwd) {
  const state = readState(cwd);
  return state?.jobs?.at(-1) ?? null;
}
// Poll until fn() is truthy or the deadline passes; returns the value or null.
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
