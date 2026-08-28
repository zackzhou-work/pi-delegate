// Seam S6: working-tree audit. Every run snapshots `git status --porcelain`
// before and after; deltas are reported with rollback hints, never blocked.
// Non-git repos get no audit and run anyway.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir, readState, latestJob, waitFor } from './helpers.mjs';

// Run with a fake-pi spec whose mutateFile simulates pi editing the tree.
function runWithMutate(args, { spec, cwd, git = true } = {}) {
  const dir = cwd || makeTempDir({ git });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const r = runCompanion(args, { cwd: dir, env: { FAKE_PI_SPEC: specFile } });
  return { r, cwd: dir };
}

test('sync run on an untouched tree reports no changes', () => {
  const { r } = runWithMutate(['run', '--sync', 'task'], { spec: { stdout: 'ok\n' } });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('ok'));
  assert.match(r.stdout, /Working tree unchanged/);
});

test('sync run reports files pi created, with rollback hints', () => {
  const { r } = runWithMutate(['run', '--sync', 'task'], {
    spec: { stdout: 'ok\n', mutateFile: 'newfile.txt', mutateContent: 'added by pi\n' },
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('newfile.txt'), 'delta must name the changed path');
  assert.ok(r.stdout.includes('git checkout'), 'rollback hint must be present');
  assert.ok(!r.stdout.includes('unchanged'), 'delta report must not say unchanged');
});

test('sync run reports pre-existing dirty files only when pi touched them', () => {
  const dir = makeTempDir({ git: true });
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'dirty before\n');
  fs.writeFileSync(path.join(dir, 'touched.txt'), 'v1\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'dirty before, still dirty\n');

  const { r } = runWithMutate(['run', '--sync', 'task'], {
    spec: { stdout: 'ok\n', mutateFile: 'touched.txt', mutateContent: 'v2 by pi\n' },
    cwd: dir,
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('touched.txt'), 'pi-touched file must be reported');
  assert.ok(!r.stdout.includes('unrelated.txt'), 'pre-existing dirt must not be blamed on pi');
});

test('background job result carries the tree report', async () => {
  const dir = makeTempDir({ git: true });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'answer\n', mutateFile: 'bg-change.txt' }));
  const r = runCompanion(['run', 'task'], { cwd: dir, env: { FAKE_PI_SPEC: specFile } });
  assert.equal(r.code, 0);
  const job = await waitFor(() => {
    const j = latestJob(dir);
    return j && j.status === 'done' ? j : null;
  });
  assert.ok(job);
  const result = fs.readFileSync(job.result_file, 'utf8');
  assert.ok(result.includes('bg-change.txt'));
  assert.ok(result.includes('git checkout'));
});

test('non-git repo: no audit, run still succeeds', () => {
  const { r } = runWithMutate(['run', '--sync', 'task'], {
    spec: { stdout: 'ok\n', mutateFile: 'no-repo-change.txt' },
    git: false,
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('[pi-delegate] tree'), 'non-git run must not fabricate an audit');
});