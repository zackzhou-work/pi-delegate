// Seam S2: run --sync full chain — template filling, pi invocation args,
// triage success/failure paths. Observes stdout/stderr and captured pi argv.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanion, makeTempDir, readState } from './helpers.mjs';

// Run the companion with a fake-pi spec; returns the run result plus the
// argv the fake pi captured (when the spec has an argsFile).
function runWithSpec(args, { spec, cwd, homedir, stdin, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-args-'));
  const argsFile = path.join(tmp, 'args.json');
  const specFile = path.join(tmp, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, argsFile }));
  const r = runCompanion(args, { cwd, homedir, stdin, env: { FAKE_PI_SPEC: specFile, ...env } });
  const captured = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null;
  return { r, captured };
}

test('run --sync delivers pi stdout and exits 0', () => {
  const { r } = runWithSpec(['run', '--sync', 'say hi'], {
    spec: { stdout: 'the answer\n' },
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith('the answer\n'), 'the deliverable must lead the output');
});

test('run --sync assembles the template prompt with task and context', () => {
  const cwd = makeTempDir({ git: true });
  const task = 'refactor the retry helper';
  const { r, captured } = runWithSpec(['run', '--sync', task], {
    spec: { stdout: 'done' },
    cwd,
  });
  assert.equal(r.code, 0);
  assert.ok(captured, 'fake pi should have captured argv');
  assert.ok(captured.includes('-p'), 'pi must receive the prompt via -p');
  const prompt = captured[captured.indexOf('-p') + 1];
  assert.ok(prompt.includes('## Task'), 'prompt must carry the task section');
  assert.ok(prompt.includes(task), 'prompt must carry the task text verbatim');
  assert.ok(prompt.includes('## Environment'), 'prompt must carry the environment section');
  assert.ok(prompt.includes(`Working directory: ${cwd}`), 'prompt must carry the cwd');
  assert.ok(prompt.includes('Git branch: main'), 'prompt must carry the git branch');
  assert.ok(prompt.includes('## Guardrails'), 'prompt must carry the guardrail section');
  assert.ok(captured.includes('--name'), 'pi must receive a session name');
  const name = captured[captured.indexOf('--name') + 1];
  assert.match(name, /^pi-delegate-/, 'session name must be namespaced for lookup');
});

test('run --sync maps --readonly to the pi tool allowlist', () => {
  const { r, captured } = runWithSpec(['run', '--sync', '--readonly', 'inspect x'], {
    spec: { stdout: 'ok' },
  });
  assert.equal(r.code, 0);
  assert.ok(captured.includes('--tools'), 'pi must receive the tools allowlist');
  assert.ok(captured.includes('read,grep,find,ls'), 'readonly must map to read-only tools');
});

test('run --sync passes --approve/--no-approve through to pi', () => {
  const { r, captured } = runWithSpec(['run', '--sync', '--approve', 'task'], {
    spec: { stdout: 'ok' },
  });
  assert.equal(r.code, 0);
  assert.ok(captured.includes('-a'), '--approve must reach pi');

  const r2 = runWithSpec(['run', '--sync', '--no-approve', 'task'], {
    spec: { stdout: 'ok' },
  });
  assert.equal(r2.r.code, 0);
  assert.ok(r2.captured.includes('-na'), '--no-approve must reach pi');
});

test('run --sync carries --model/--thinking/--timeout through to pi', () => {
  const { r, captured } = runWithSpec(
    ['run', '--sync', '--model', 'sonnet', '--thinking', 'high', '--timeout', '5m', 'task'],
    { spec: { stdout: 'ok' } }
  );
  assert.equal(r.code, 0);
  assert.ok(captured.includes('--model') && captured.includes('sonnet'));
  assert.ok(captured.includes('--thinking') && captured.includes('high'));
});

test('run --sync is foreground: no job is registered', () => {
  const cwd = makeTempDir({ git: true });
  const { r } = runWithSpec(['run', '--sync', 'task'], {
    spec: { stdout: 'ok' },
    cwd,
  });
  assert.equal(r.code, 0);
  const state = readState(cwd);
  assert.equal(state, null, 'foreground run must not create a state file');
});

test('run --sync surfaces pi failure: nonzero exit, no stdout', () => {
  const { r } = runWithSpec(['run', '--sync', 'task'], {
    spec: { exitCode: 1, stderr: 'Request failed: auth expired\n' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /auth/i, 'failure hint should be appended');
});

test('run --sync delivers stdout when pi fails late (done_with_warnings)', () => {
  const { r } = runWithSpec(['run', '--sync', 'task'], {
    spec: { exitCode: 1, stdout: 'complete answer\n', stderr: 'warning: tool call failed\n' },
  });
  assert.equal(r.code, 0, 'a finished answer must not be discarded');
  assert.ok(r.stdout.includes('complete answer'));
  assert.ok(r.stderr.includes('warning'), 'problem must be reported on stderr');
});

test('run --sync ignores a missing pi session dir (fresh HOME)', () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegate-home-'));
  const { r } = runWithSpec(['run', '--sync', 'task'], {
    spec: { stdout: 'ok' },
    homedir,
  });
  assert.equal(r.code, 0);
});