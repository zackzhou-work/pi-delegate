// Seam S8: continue — resume the pi session of the most recent job. The
// session file is located lazily by scanning the pi sessions dir for a
// session_info entry named `pi-delegate-<jobId>`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir, latestJob, waitFor } from './helpers.mjs';

// Forge a pi session file under homedir for the given cwd + display name.
// The filename is derived from the name so distinct forges never collide.
function forgeSession(homedir, cwd, name, { mtime } = {}) {
  const dir = path.join(homedir, '.pi', 'agent', 'sessions', `--${cwd.replaceAll('/', '-')}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-08-28T00-00-00-000Z_${name.replaceAll('-', '')}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session', id: 'sess-1', timestamp: '2026-08-28T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'session_info', id: 'info-1', parentId: null, timestamp: '2026-08-28T00:00:00.001Z', name }),
    JSON.stringify({ type: 'message', id: 'm-1', parentId: null, timestamp: '2026-08-28T00:00:00.002Z', message: { role: 'user', content: 'hi', timestamp: 1 } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

// Start a real companion job in an isolated HOME, return { cwd, homedir, job }.
async function startJob(homedir) {
  const cwd = makeTempDir({ git: true });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'answer\n' }));
  runCompanion(['run', 'initial task'], { cwd, homedir, env: { FAKE_PI_SPEC: specFile } });
  const job = await waitFor(() => latestJob(cwd));
  assert.ok(job, 'job must be registered');
  return { cwd, homedir, job };
}

test('continue resumes the most recent job session with --session', async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const { cwd, job } = await startJob(homedir);
  forgeSession(homedir, cwd, `pi-delegate-${job.id}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-args-'));
  const argsFile = path.join(tmp, 'args.json');
  const specFile = path.join(tmp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'follow-up answer\n', argsFile }));
  const r = runCompanion(['continue', '--sync', 'also fix the error path'], {
    cwd,
    homedir,
    env: { FAKE_PI_SPEC: specFile },
  });
  assert.equal(r.code, 0, r.stderr);
  const captured = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.ok(captured.includes('--session'), 'pi must resume the session');
  const sessionPath = captured[captured.indexOf('--session') + 1];
  assert.ok(sessionPath.includes('jsonl'), 'session path must point at a session file');
  const prompt = captured[captured.indexOf('-p') + 1];
  assert.ok(prompt.includes('also fix the error path'), 'follow-up must reach pi as the task');
});

test('continue keeps the job session name stable across runs', async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const { cwd, job } = await startJob(homedir);
  forgeSession(homedir, cwd, `pi-delegate-${job.id}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-args-'));
  const specFile = path.join(tmp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'ok\n', argsFile: path.join(tmp, 'args.json') }));
  const r = runCompanion(['continue', '--sync', 'more'], { cwd, homedir, env: { FAKE_PI_SPEC: specFile } });
  assert.equal(r.code, 0);
  const captured = JSON.parse(fs.readFileSync(path.join(tmp, 'args.json'), 'utf8'));
  assert.ok(captured.includes(`--name`) && captured.includes(`pi-delegate-${job.id}`));
});

test('continue finds the matching session even when a newer one exists', async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const { cwd, job } = await startJob(homedir);
  const match = forgeSession(homedir, cwd, `pi-delegate-${job.id}`, { mtime: new Date('2026-08-01') });
  const newer = forgeSession(homedir, cwd, 'pi-delegate-other', { mtime: new Date('2026-08-29') });
  assert.ok(newer);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-args-'));
  const specFile = path.join(tmp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stdout: 'ok\n', argsFile: path.join(tmp, 'args.json') }));
  const r = runCompanion(['continue', '--sync', 'more'], { cwd, homedir, env: { FAKE_PI_SPEC: specFile } });
  assert.equal(r.code, 0, r.stderr);
  const captured = JSON.parse(fs.readFileSync(path.join(tmp, 'args.json'), 'utf8'));
  assert.equal(captured[captured.indexOf('--session') + 1], match, 'the matching session must win');
});

test('continue without a runnable session errors with guidance', async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const { cwd } = await startJob(homedir);
  const r = runCompanion(['continue', '--sync', 'follow up'], { cwd, homedir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no session/i);
});

test('continue without any previous job errors', () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const cwd = makeTempDir({ git: true });
  const r = runCompanion(['continue', 'follow up'], { cwd, homedir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no previous/i);
});