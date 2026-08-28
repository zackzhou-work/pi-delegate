// Seam S10: concurrency. State writes (dispatch registration, worker
// finalization, cancel) must never lose records or tear the file, even when
// many runs and status calls overlap. wait/status poll read-only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION, FAKE_PI, makeTempDir, waitFor } from './helpers.mjs';

function spawnRun(cwd, specFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, 'run', 'task'], {
      cwd,
      env: { ...process.env, PI_BIN: FAKE_PI, FAKE_PI_SPEC: specFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('concurrent runs register every job and finish without loss', async () => {
  const cwd = makeTempDir({ git: true });
  const specs = Array.from({ length: 6 }, (_, i) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-'));
    const f = path.join(dir, 'spec.json');
    fs.writeFileSync(f, JSON.stringify({ stdout: `answer ${i}\n` }));
    return f;
  });

  const results = await Promise.all(specs.map((s) => spawnRun(cwd, s)));
  for (const r of results) assert.equal(r.code, 0, `job start must succeed: ${r.out} ${r.err}`);

  const state = await waitFor(() => {
    const raw = fs.readFileSync(path.join(cwd, '.pi-delegate', 'state.json'), 'utf8');
    const jobs = JSON.parse(raw).jobs || [];
    return jobs.length === 6 ? jobs : null;
  });
  assert.ok(state, 'all 6 jobs must be registered, none lost');

  const done = await waitFor(() => {
    const raw = fs.readFileSync(path.join(cwd, '.pi-delegate', 'state.json'), 'utf8');
    const jobs = JSON.parse(raw).jobs || [];
    return jobs.every((j) => j.status === 'done') ? jobs : null;
  });
  assert.ok(done, 'all jobs must reach done');
  for (const j of done) {
    assert.ok(fs.existsSync(j.result_file), `result ${j.id} must exist`);
  }
});

test('status calls during heavy finishing never corrupt state', async () => {
  const cwd = makeTempDir({ git: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-'));
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'ok\n', delayMs: 250 }));
  const ps = Array.from({ length: 4 }, () => spawnRun(cwd, specFile));
  await Promise.all(ps);

  // Hammer status while the finalizers run; every read must parse cleanly.
  for (let i = 0; i < 15; i++) {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [COMPANION, 'status'], {
        cwd,
        env: { ...process.env, PI_BIN: FAKE_PI },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, out, err }));
    });
    assert.equal(r.code, 0, `status must never crash: ${r.err}`);
    assert.ok(!/corrupt/.test(r.err), 'state must never be corrupt');
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(cwd, '.pi-delegate', 'state.json'), 'utf8')).jobs.length === 4);
});