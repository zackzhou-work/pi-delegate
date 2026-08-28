// Seam S7: triage branches — failure hints (auth/model/quota/sandbox), pi
// timeout with grace, and delivery of a late answer (done_with_warnings).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir } from './helpers.mjs';

function runFailing({ stderr = '', exitCode = 1, stdout, delayMs, graceMs, timeout = '30s' }) {
  const cwd = makeTempDir({ git: true });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ stderr, stdout, exitCode, delayMs }));
  const env = { FAKE_PI_SPEC: specFile };
  if (graceMs) env.PI_DELEGATE_GRACE_MS = String(graceMs);
  return runCompanion(['run', '--sync', '--timeout', timeout, 'task'], { cwd, env });
}

test('sandbox signature produces an unsandboxed hint', () => {
  const r = runFailing({ stderr: 'Error: EPERM: operation not permitted, open /Users/x/.pi/agent/settings.json\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /sandbox/i);
  assert.match(r.stderr, /unsandboxed/i);
});

test('auth failures suggest re-login', () => {
  const r = runFailing({ stderr: '401 unauthorized\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /re-login/i);
});

test('model failures suggest checking --model', () => {
  const r = runFailing({ stderr: 'unknown model "gemini-blah"\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--model/i);
});

test('quota failures are named', () => {
  const r = runFailing({ stderr: '429 Too Many Requests: rate limit exceeded\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quota/i);
});

test('unknown failures carry the raw stderr but no invented cause', () => {
  const r = runFailing({ stderr: 'something odd happened\n' });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('something odd happened'));
  assert.ok(!r.stderr.includes('Likely cause'), 'no hint must be fabricated for unknown errors');
});

test('pi exceeding its budget is reported as a timeout', () => {
  const r = runFailing({ delayMs: 2000, graceMs: 50, timeout: '1s' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /timed out/i);
});