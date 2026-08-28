// Seam S4: job management — wait/status/result/cancel. Exit codes are the
// contract: 0 done, 2 still running, 3 error/crashed, 4 canceled, 1 companion
// error. Callers branch on codes, never on parsed output.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir, readState, latestJob, waitFor } from './helpers.mjs';

// Start a background job with the given fake-pi spec; poll until the job
// record exists, then return { cwd, job }.
async function startJob({ spec = { stdout: 'answer\n' }, cwd } = {}) {
  const dir = cwd || makeTempDir({ git: true });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  runCompanion(['run', 'task'], { cwd: dir, env: { FAKE_PI_SPEC: specFile } });
  const job = await waitFor(() => latestJob(dir));
  assert.ok(job, 'job must be registered');
  return { cwd: dir, job };
}

test('wait blocks until done, prints the result and exits 0', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'the answer\n', delayMs: 200 } });
  const r = runCompanion(['wait', job.id, '--timeout', '30s'], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('the answer'));
  assert.ok(r.stdout.includes(`# Job ${job.id}`), 'result must carry the job header');
});

test('wait exits 2 on its own timeout and can be rerun', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'the answer\n', delayMs: 1500 } });
  const r1 = runCompanion(['wait', job.id, '--timeout', '200ms'], { cwd });
  assert.equal(r1.code, 2, 'expired wait is not a failure');
  assert.match(r1.stdout, /still running/);
  const r2 = runCompanion(['wait', job.id, '--timeout', '30s'], { cwd });
  assert.equal(r2.code, 0);
  assert.ok(r2.stdout.includes('the answer'));
});

test('wait without an id targets the most recent job', async () => {
  const { cwd } = await startJob({ spec: { stdout: 'latest answer\n', delayMs: 150 } });
  const r = runCompanion(['wait', '--timeout', '30s'], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('latest answer'));
});

test('wait on an unknown id is a companion error (exit 1)', async () => {
  const { cwd } = await startJob();
  const r = runCompanion(['wait', 'run-does-not-exist', '--timeout', '1s'], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no job/);
});

test('wait emits liveness heartbeats on stderr, never stdout', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'answer\n', delayMs: 600 } });
  const r = runCompanion(['wait', job.id, '--timeout', '10s'], {
    cwd,
    env: { PI_DELEGATE_HEARTBEAT_MS: '30' },
  });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /still waiting on/);
  assert.ok(!r.stdout.includes('still waiting'), 'heartbeats must not pollute the deliverable');
});

test('status without an id lists jobs as a table', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'answer\n', delayMs: 400 } });
  const r = runCompanion(['status'], { cwd });
  assert.equal(r.code, 0, `status must succeed: ${r.stderr}`);
  assert.ok(r.stdout.includes(job.id), `job id must be listed: ${r.stdout}`);
  assert.ok(r.stdout.includes('| status |'), `table header must be present: ${r.stdout}`);
});

test('status <id> reports the job JSON and exits with the job code', async () => {
  const done = await startJob({ spec: { stdout: 'answer\n', delayMs: 200 } });
  await waitFor(() => {
    const j = latestJob(done.cwd);
    return j && j.status === 'done' ? j : null;
  });
  const r = runCompanion(['status', done.job.id], { cwd: done.cwd });
  assert.equal(r.code, 0, 'done job must exit 0');
  assert.ok(r.stdout.includes(`"status": "done"`));

  const running = await startJob({ spec: { stdout: 'answer\n', delayMs: 1500 } });
  const r2 = runCompanion(['status', running.job.id], { cwd: running.cwd });
  assert.equal(r2.code, 2, 'running job must exit 2');
});

test('result re-prints a finished job output', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'stored answer\n' } });
  await waitFor(() => {
    const j = latestJob(cwd);
    return j && j.status === 'done' ? j : null;
  });
  const r = runCompanion(['result', job.id], { cwd });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('stored answer'));
});

test('result on a running job is an error', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'answer\n', delayMs: 1500 } });
  const r = runCompanion(['result', job.id], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /still running/);
});

test('cancel stops a running job and marks it canceled (wait exits 4)', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'answer\n', delayMs: 4000 } });
  const c = runCompanion(['cancel', job.id], { cwd });
  assert.equal(c.code, 0);
  assert.match(c.stdout, /Canceled/);
  const state = await waitFor(() => {
    const j = latestJob(cwd);
    return j && j.status === 'canceled' ? j : null;
  });
  assert.ok(state, 'job must be marked canceled');
  const r = runCompanion(['wait', job.id, '--timeout', '2s'], { cwd });
  assert.equal(r.code, 4, 'wait must surface the cancel code');
});

test('a worker that dies without updating state is reported as crashed', async () => {
  const { cwd, job } = await startJob({ spec: { stdout: 'answer\n', delayMs: 4000 } });
  process.kill(job.pid, 'SIGKILL');
  const r = await waitFor(() => {
    const rr = runCompanion(['status', job.id], { cwd });
    return rr.code === 3 ? rr : null;
  });
  assert.ok(r, 'status must report the crash with exit 3');
  assert.ok(r.stdout.includes('crashed'));
});