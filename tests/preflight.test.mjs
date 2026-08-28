// Seam S9: preflight — run/continue fail fast with guidance when pi is
// missing, instead of hanging or failing deep inside a job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir } from './helpers.mjs';

const MISSING_PI = '/nonexistent/pi-delegate-bin';

test('run fails fast when pi is missing', () => {
  const cwd = makeTempDir({ git: true });
  const r = runCompanion(['run', '--sync', 'task'], { cwd, env: { PI_BIN: MISSING_PI } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi CLI not found/i);
  assert.match(r.stderr, /--version/);
  assert.equal(r.stdout, '', 'preflight failure must not print a collect hint');
});

test('continue fails fast when pi is missing', () => {
  const cwd = makeTempDir({ git: true });
  const r = runCompanion(['continue', '--sync', 'follow up'], { cwd, env: { PI_BIN: MISSING_PI } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi CLI not found/i);
});