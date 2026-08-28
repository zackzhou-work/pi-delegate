// Seam S3: background job lifecycle — register-before-spawn, spec file,
// collect hint, worker completion and failure storage.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir, readState, latestJob, waitFor } from './helpers.mjs';

// Run a background job with the given fake-pi spec; returns run result + cwd.
function startJob(args, { spec = { stdout: 'answer\n' }, cwd } = {}) {
  const dir = cwd || makeTempDir({ git: true });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const r = runCompanion(['run', ...args], { cwd: dir, env: { FAKE_PI_SPEC: specFile } });
  return { r, cwd: dir };
}

test('run starts a background job and prints the collect hint', async () => {
  // A slow fake pi keeps the job in running long enough to observe it.
  const { r, cwd } = startJob(['solve it'], { spec: { stdout: 'answer\n', delayMs: 400 } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Started background run job/);
  assert.match(r.stdout, /job id: run-[0-9a-z]+/);
  assert.match(r.stdout, /Collect: run `wait run-[0-9a-z]+ --timeout \d+m`/);
  const job = await waitFor(() => latestJob(cwd));
  assert.ok(job, 'job must be registered');
  assert.equal(job.status, 'running');
  assert.equal(typeof job.pid, 'number', 'pid must be backfilled');
});

test('the collect hint timeout outlives the job timeout', () => {
  const { r } = startJob(['solve it']);
  const m = /--timeout (\d+)m/.exec(r.stdout);
  assert.ok(m, 'collect hint must carry a timeout in minutes');
  assert.ok(Number(m[1]) >= 12, 'collect timeout must be job timeout (10m) + grace');
});

test('background job writes a spec file with the assembled prompt', async () => {
  const { cwd } = startJob(['refactor the retry helper']);
  const job = await waitFor(() => latestJob(cwd));
  const spec = JSON.parse(fs.readFileSync(path.join(cwd, '.pi-delegate', 'jobs', `${job.id}.spec.json`), 'utf8'));
  assert.ok(spec.task.includes('refactor the retry helper'));
});

test('.pi-delegate is excluded from git status', async () => {
  const { cwd } = startJob(['task']);
  await waitFor(() => latestJob(cwd));
  const exclude = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes('.pi-delegate'), 'state dir must be repo-local ignored');
});

test('the worker completes and stores the result', async () => {
  const { r, cwd } = startJob(['solve it'], { spec: { stdout: 'the answer\n' } });
  assert.equal(r.code, 0);
  const job = await waitFor(() => {
    const j = latestJob(cwd);
    return j && j.status === 'done' ? j : null;
  });
  assert.ok(job, 'job must reach done');
  const result = fs.readFileSync(job.result_file || path.join(cwd, '.pi-delegate', 'jobs', `${job.id}.result.md`), 'utf8');
  assert.ok(result.includes('the answer'));
});

test('worker failure marks the job error and stores the failure', async () => {
  const { r, cwd } = startJob(['solve it'], { spec: { exitCode: 1, stderr: 'boom\n' } });
  assert.equal(r.code, 0, 'job start must not fail synchronously');
  const job = await waitFor(() => {
    const j = latestJob(cwd);
    return j && j.status === 'error' ? j : null;
  });
  assert.ok(job, 'job must reach error');
  const result = fs.readFileSync(job.result_file || path.join(cwd, '.pi-delegate', 'jobs', `${job.id}.result.md`), 'utf8');
  assert.ok(result.toLowerCase().includes('boom'), 'failure text must be stored');
});