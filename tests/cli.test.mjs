// Seam S1: CLI surface — subcommand dispatch, flag parsing, task text
// single-source rule. All tests observe exit codes and stdout/stderr only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion } from './helpers.mjs';

test('bare invocation prints usage and exits 1', () => {
  const r = runCompanion([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage/i);
});

test('unknown subcommand exits 1 with a clear error', () => {
  const r = runCompanion(['frobnicate', 'do the thing']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown subcommand: frobnicate/);
});

test('run without a task text is rejected', () => {
  const r = runCompanion(['run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs a task/i);
});

test('default run without a task text is rejected', () => {
  const r = runCompanion(['--sync']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs a task/i);
});

test('task text from more than one source is rejected', () => {
  const r = runCompanion(['run', '--stdin', 'inline task']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /more than one way/);
});

test('unknown flag is rejected with its name', () => {
  const r = runCompanion(['run', '--bogus', 'task']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --bogus/);
});

test('--approve and --no-approve are mutually exclusive', () => {
  const r = runCompanion(['run', '--approve', '--no-approve', 'task']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /mutually exclusive/);
});

test('invalid --timeout value is rejected', () => {
  const r = runCompanion(['run', '--sync', '--timeout', 'nope', 'task']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid --timeout/);
});

test('unreadable --prompt-file is rejected', () => {
  const r = runCompanion(['run', '--prompt-file', '/nonexistent/x.md']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read --prompt-file/);
});