#!/usr/bin/env node
// pi-delegate companion: delegates a single task to a local pi agent.
//
// The whole plugin is one CLI: skills and harness plugins are thin shells
// that forward commands to this script. Running a task is async by default
// (background job + wait), --sync forces the foreground path.
// Job state lives in .pi-delegate/ under the repo root; all writes are
// atomic (tmp + rename) so detached workers never tear the file.
// Black-box tested against a fake pi via tests/*.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const TEMPLATE = path.join(path.dirname(SELF), '..', 'templates', 'prompt.md');
const PI_BIN = process.env.PI_BIN || 'pi';
const MAX_INLINE_BYTES = 200 * 1024;
const DEFAULT_TIMEOUT = '10m';
const GRACE_MS = 60_000;

const VALUE_FLAGS = new Set(['prompt-file', 'model', 'provider', 'thinking', 'timeout']);
const BOOL_FLAGS = new Set(['sync', 'stdin', 'continue', 'approve', 'no-approve', 'readonly', 'no-session']);

const MODES = ['run', 'wait', 'status', 'result', 'cancel', 'continue'];

// ---------------------------------------------------------------------------
// pi session lookup (continue)
// ---------------------------------------------------------------------------

function sessionsDirFor(cwd) {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${cwd.replaceAll('/', '-')}--`);
}

// The display name is stored as a session_info entry inside the session file
// (the file header carries no name). Match on the JSON substring — names are
// machine-generated [a-z0-9-], so substring matching is exact. Pick the
// newest matching file; a foreign session never wins.
function findSessionFile(name, cwd) {
  const dir = sessionsDirFor(cwd);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const needle = `"name":"${name}"`;
  let best = null;
  let bestMtime = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    try {
      const head = fs.readFileSync(p, { encoding: 'utf8' }).slice(0, 16_384);
      if (!head.includes(needle)) continue;
      const mtime = fs.statSync(p).mtimeMs;
      if (mtime > bestMtime) {
        best = p;
        bestMtime = mtime;
      }
    } catch {
      // unreadable session: skip
    }
  }
  return best;
}

// Read-only status derivation shared by status/wait's poll loop. Polling must
// never write state.json: a concurrent worker write would be clobbered.
function pidAlive(pid) {
  if (pid == null) return true; // registered, pid backfill pending — treat as running
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function liveJobStatus(job) {
  if (job.status !== 'running') return job.status;
  if (pidAlive(job.pid)) return 'running';
  return fs.existsSync(job.result_file) ? 'done' : 'crashed';
}

// Persistent normalization: after a job reached a terminal state, detect
// workers that died without updating their record (crashed vs done).
function refreshJobs(state) {
  for (const job of state.jobs || []) {
    if (job.status === 'running' && !pidAlive(job.pid)) {
      const hasResult = fs.existsSync(job.result_file);
      job.status = hasResult ? 'done' : 'crashed';
      job.finished_at = job.finished_at || new Date().toISOString();
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function die(msg, code = 1) {
  process.stderr.write(`pi-delegate error: ${msg}\n`);
  process.exit(code);
}

// Duration strings like "5m", "90s", "250ms" → ms, or null when invalid.
function durationToMs(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(d);
  if (!m) return null;
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  return Math.round(parseFloat(m[1]) * mult);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function repoRoot() {
  const r = sh('git', ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out ? r.out : process.cwd();
}

// ---------------------------------------------------------------------------
// state (repo-local, atomic writes)
// ---------------------------------------------------------------------------

function stateDir() {
  return path.join(repoRoot(), '.pi-delegate');
}

function statePath() {
  return path.join(stateDir(), 'state.json');
}

// Create the state dir on first use and keep it out of git status via the
// repo-local .git/info/exclude (never the team's .gitignore).
function ensureStateDir() {
  const dir = stateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (sh('git', ['check-ignore', '-q', dir]).code !== 0) {
      const p = sh('git', ['rev-parse', '--git-path', 'info/exclude']);
      if (p.code === 0 && p.out) {
        try {
          fs.appendFileSync(path.resolve(p.out), '.pi-delegate/\n');
        } catch {
          // best-effort: a read-only repo must not block a run
        }
      }
    }
  }
  return dir;
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(statePath(), 'utf8');
  } catch {
    return { jobs: [] };
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Never silently reset: every caller writes state back, which would wipe
    // all job records and conversation ids.
    die(`state file is corrupt: ${statePath()} — fix or delete it, then retry`);
  }
}

function saveState(state) {
  ensureStateDir();
  const tmp = statePath() + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath());
}

// Serialize every read-modify-write cycle on state.json across processes.
// mkdir is atomic, so the lock directory is the mutex; a lock whose owner
// pid is gone is stale and gets taken over. Readers (wait/status) never lock.
function withStateLock(fn) {
  const lock = statePath() + '.lock';
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        if (!pidAlive(owner)) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // no pid file yet, or the lock vanished — retry soon
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > 5000) {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock gone between the read and the stat: retry the loop
        }
      }
      if (Date.now() > deadline) die('state lock not acquired in time — concurrent writers stalled');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// flag parsing
// ---------------------------------------------------------------------------

function parseFlags(tokens) {
  const opts = { _: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const name = t.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const v = tokens[++i];
        if (v === undefined) die(`flag --${name} needs a value`);
        opts[name] = v;
      } else if (BOOL_FLAGS.has(name)) {
        opts[name] = true;
      } else {
        die(`unknown flag --${name}`);
      }
    } else {
      opts._.push(t);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// task text
// ---------------------------------------------------------------------------

// Task text comes from exactly one source: inline argv, --prompt-file, or
// --stdin. Long prompts should use the file/stdin forms over shell quoting.
function taskText(opts) {
  const inline = opts._.join(' ').trim();
  const sources = [inline && 'inline text', opts['prompt-file'] && '--prompt-file', opts.stdin && '--stdin'].filter(Boolean);
  if (sources.length > 1) die(`task text given more than one way (${sources.join(', ')}) — use exactly one`);
  if (opts['prompt-file']) {
    try {
      return fs.readFileSync(opts['prompt-file'], 'utf8').trim();
    } catch (e) {
      die(`cannot read --prompt-file ${opts['prompt-file']}: ${e.message}`);
    }
  }
  if (opts.stdin) {
    try {
      return fs.readFileSync(0, 'utf8').trim();
    } catch (e) {
      die(`cannot read task text from stdin: ${e.message}`);
    }
  }
  return inline;
}

// ---------------------------------------------------------------------------
// prompt building
// ---------------------------------------------------------------------------

function fillTemplate(vars) {
  let text;
  try {
    text = fs.readFileSync(TEMPLATE, 'utf8');
  } catch {
    die(`template not found: ${TEMPLATE}`);
  }
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function gatherContext() {
  const branch = sh('git', ['branch', '--show-current']).out || '(no git branch)';
  return [
    `Working directory: ${process.cwd()}`,
    `Git branch: ${branch}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');
}

function buildPrompt(task) {
  if (Buffer.byteLength(task) > MAX_INLINE_BYTES) {
    die(`task text exceeds the ${MAX_INLINE_BYTES / 1024}KB inline limit`);
  }
  return fillTemplate({ TASK: task, CONTEXT: gatherContext() });
}

// ---------------------------------------------------------------------------
// pi invocation and triage
// ---------------------------------------------------------------------------

function runPi(resolved) {
  const args = ['-p', resolved.prompt, '--name', resolved.name];
  if (resolved.approve) args.push('-a');
  if (resolved.noApprove) args.push('-na');
  if (resolved.readonly) args.push('--tools', 'read,grep,find,ls');
  if (resolved.model) args.push('--model', resolved.model);
  if (resolved.provider) args.push('--provider', resolved.provider);
  if (resolved.thinking) args.push('--thinking', resolved.thinking);
  if (resolved.noSession) args.push('--no-session');
  if (resolved.sessionPath) args.push('--session', resolved.sessionPath);

  const graceMs = Number(process.env.PI_DELEGATE_GRACE_MS || GRACE_MS); // env knob for tests
  const budget = (durationToMs(resolved.timeout) ?? 600_000) + graceMs;
  const r = spawnSync(PI_BIN, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: budget });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    die(`pi timed out: no result within ${resolved.timeout} plus 60s grace. Retry with a larger --timeout, or narrow the task.`);
  }
  if (r.error) die(`failed to launch pi (${PI_BIN}): ${r.error.message}`);
  if (r.signal) die(`pi was killed by signal ${r.signal} before returning a result (budget: ${resolved.timeout} + 60s grace).`);
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), exit: r.status ?? 0 };
}

// Classify the pi result. Text mode is simple: an answer means exit 0; the
// only edge is a nonzero exit that still produced output (deliver it, warn).
function triage({ stdout, stderr, exit }) {
  if (exit === 0) return stdout;
  if (stdout) {
    // done_with_warnings: the answer was produced before something failed.
    process.stderr.write(`pi-delegate warning: pi exited ${exit} but returned a complete response — delivering it anyway.\n`);
    if (stderr) process.stderr.write(`${stderr}\n`);
    return stdout;
  }
  let msg = `pi failed (exit ${exit}).`;
  if (stderr) msg += `\npi stderr: ${stderr}`;
  const hints = [];
  if (/model|effort/i.test(stderr)) hints.push('invalid model id (check --model; run `pi --list-models`)');
  if (/auth|login|credential|unauthorized|401|403/i.test(stderr)) hints.push('expired auth (run `pi` interactively once to re-login)');
  if (/quota|rate.?limit|resource.?exhausted|429/i.test(stderr)) hints.push('exhausted quota');
  if (/operation not permitted|EACCES|EPERM/i.test(stderr)) {
    hints.push(
      'a harness command sandbox is blocking pi (~/.pi access or network). Run this command unsandboxed ' +
        'or with full permissions.'
    );
  }
  if (hints.length) msg += `\nLikely cause: ${hints.join('; ')}.`;
  die(msg);
}

// ---------------------------------------------------------------------------
// working-tree audit (no preconditions, report only)
// ---------------------------------------------------------------------------

// Porcelain lines as an array, or null when git cannot tell us (no repo).
function porcelainSnapshot() {
  const r = sh('git', ['status', '--porcelain']);
  if (r.code !== 0) return null;
  return r.out ? r.out.split('\n') : [];
}

// Lines that appeared during the run, plus lines whose status changed for a
// path that was already dirty (e.g. " M f" → "MM f").
function porcelainDelta(before, after) {
  const seen = new Map();
  for (const line of before) seen.set(line.slice(3), line);
  return after.filter((line) => seen.get(line.slice(3)) !== line);
}

// Deliverable suffix: the tree report is information for the calling agent,
// never a block. Wording stays neutral — a task may legitimately edit files.
function treeReport(before, after) {
  if (!before || !after) return '';
  const delta = porcelainDelta(before, after);
  if (!delta.length) {
    return '[pi-delegate] Working tree unchanged — pi made no file edits.\n';
  }
  // Stat scoped to the delta paths: pre-existing dirt stays out of the report.
  const paths = delta.map((l) => l.slice(3));
  const diffStat = sh('git', ['diff', '--stat', '--', ...paths]).out || '(only new untracked files)\n';
  const untracked = delta
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3))
    .join(', ');
  let out =
    `[pi-delegate] pi modified the working tree during the run (${delta.length} path(s): ${paths.join(
      ', '
    )}).\n` +
    `Review with \`git diff\` before adopting. Rollback: \`git checkout -- <path>\` ` +
    (untracked ? `for tracked files, rm ${untracked} for untracked ones. ` : 'for changed files. ') +
    `git checkout . undoes all tracked edits.\n` +
    `git diff --stat (delta paths):\n${diffStat}\n`;
  return out;
}

// Run one task against pi and return the deliverable text (or die()).
function executeRun(resolved) {
  const treeBefore = porcelainSnapshot();
  const result = runPi(resolved);
  const treeAfter = porcelainSnapshot();
  const deliverable = triage(result);
  return deliverable + '\n' + treeReport(treeBefore, treeAfter);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function preflight() {
  const r = spawnSync(PI_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error || r.status !== 0) {
    die(
      `pi CLI not found or not working (tried \`${PI_BIN} --version\`). ` +
        'Install @earendil-works/pi-coding-agent and make sure `pi` is on PATH, ' +
        'or point PI_BIN at the binary.'
    );
  }
}

function resolveRun(opts) {
  if (opts.approve && opts['no-approve']) {
    die('--approve and --no-approve are mutually exclusive');
  }
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  if (durationToMs(timeout) == null) die(`invalid --timeout "${timeout}" (examples: 100s, 5m)`);
  return {
    timeout,
    readonly: !!opts.readonly,
    sync: !!opts.sync,
    approve: !!opts.approve,
    noApprove: !!opts['no-approve'],
    model: opts.model || null,
    provider: opts.provider || null,
    thinking: opts.thinking || null,
    noSession: !!opts['no-session'],
  };
}

// ---------------------------------------------------------------------------
// background jobs
// ---------------------------------------------------------------------------

// A wait --timeout that outlives the job itself: job timeout + grace + slack.
function collectTimeout(jobTimeout) {
  const ms = (durationToMs(jobTimeout) ?? 600_000) + 2 * GRACE_MS;
  return `${Math.ceil(ms / 60_000)}m`;
}

// Start a detached worker and return its job id. The job record is written
// BEFORE the spawn so a fast worker's own state update finds it present.
function dispatch(resolved, task) {
  const jobId = `run-${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
  resolved.name = `pi-delegate-${jobId}`;
  resolved.prompt = buildPrompt(task);
  const jobsDir = path.join(ensureStateDir(), 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const specFile = path.join(jobsDir, `${jobId}.spec.json`);
  const resultFile = path.join(jobsDir, `${jobId}.result.md`);

  fs.writeFileSync(specFile, JSON.stringify({ resolved, task }, null, 2));

  // Register BEFORE spawning within the state lock, so concurrent dispatches
  // cannot lose each other's records and a fast worker finds its record.
  withStateLock(() => {
    const state = loadState();
    state.jobs = state.jobs || [];
    state.jobs.push({
      id: jobId,
      mode: 'run',
      pid: null,
      status: 'running',
      started_at: new Date().toISOString(),
      log_file: logFile,
      result_file: resultFile,
    });
    saveState(state);
  });

  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [SELF, '_worker', jobId], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  // Backfill the pid, preserving whatever status the worker may have written.
  withStateLock(() => {
    const after = loadState();
    const rec = (after.jobs || []).find((j) => j.id === jobId);
    if (rec) {
      rec.pid = child.pid;
      saveState(after);
    }
  });

  // The collect hint is the canonical contract: one background wait per job,
  // bounded by the job's own timeout plus the companion's grace.
  process.stdout.write(
    `Started background run job.\n` +
      `job id: ${jobId} (pid ${child.pid})\n` +
      `timeout: ${resolved.timeout}\n` +
      `result file (written when the job finishes): ${resultFile}\n` +
      `Collect: run \`wait ${jobId} --timeout ${collectTimeout(resolved.timeout)}\` as a background command ` +
      `(one background wait per job; exit 0 = result printed, 2 = still running — wait again).\n` +
      `Peek: \`status ${jobId}\`   Stop: \`cancel ${jobId}\`\n`
  );
}

function cmdRun(opts) {
  preflight();
  const resolved = resolveRun(opts);
  const task = taskText(opts);
  if (!task) die('run needs a task description');

  if (resolved.sync) {
    resolved.name = `pi-delegate-sync-${Date.now().toString(36)}`;
    resolved.prompt = buildPrompt(task);
    process.stdout.write(executeRun(resolved) + '\n');
    return;
  }

  // Background: the job id names the pi session so continue can find it.
  dispatch(resolved, task);
}

// Continue the pi session of the most recent job. The session is located
// lazily: the job id derives the display name, which the session file carries
// as a session_info entry. Execution style follows run (background by default).
function cmdContinue(opts) {
  preflight();
  const resolved = resolveRun(opts);
  const task = taskText(opts);
  if (!task) die('continue needs follow-up text');
  const state = loadState();
  const job = (state.jobs || []).at(-1);
  if (!job) die('no previous pi-delegate job in this repository — run a task first');
  resolved.name = `pi-delegate-${job.id}`;
  const sessionPath = findSessionFile(resolved.name, process.cwd());
  if (!sessionPath) {
    die(
      `no session file found for job ${job.id} (looked in ${sessionsDirFor(process.cwd())}). ` +
        'Sessions are created once pi runs a task; run a task first.'
    );
  }
  resolved.sessionPath = sessionPath;
  resolved.prompt = buildPrompt(task);
  if (resolved.sync) {
    process.stdout.write(executeRun(resolved) + '\n');
    return;
  }
  dispatch(resolved, task);
}

// ---------------------------------------------------------------------------
// jobs: wait / status / result / cancel
// ---------------------------------------------------------------------------

// Machine-readable job exit codes shared by status <id> and wait. 1 stays the
// generic companion error, so callers can loop on "code 2" without parsing.
const JOB_EXIT_CODES = { done: 0, running: 2, error: 3, crashed: 3, canceled: 4 };

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function cmdStatus(opts) {
  const state = refreshJobs(loadState());
  const jobs = state.jobs || [];
  const id = opts._[0];

  if (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) die(`no job ${id} in this repository`);
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    if (job.status === 'running') {
      process.stdout.write(`\nStill running. Log tail:\n`);
      const log = fs.existsSync(job.log_file) ? fs.readFileSync(job.log_file, 'utf8') : '';
      process.stdout.write(log.split('\n').slice(-10).join('\n') + '\n');
    }
    process.exitCode = JOB_EXIT_CODES[job.status] ?? 1;
    return;
  }

  if (!jobs.length) {
    process.stdout.write('No pi-delegate jobs recorded in this repository.\n');
    return;
  }
  process.stdout.write('id | mode | status | started | finished\n');
  for (const j of jobs.slice(-20)) {
    process.stdout.write(`${j.id} | ${j.mode} | ${j.status} | ${j.started_at} | ${j.finished_at || '-'}\n`);
  }
  process.stdout.write('\nDetails: `status <id>`   Output: `result <id>`\n');
}

// Block until the job reaches a terminal state, then print its result —
// wait + result in one call. Bounded by its own --timeout (default 100s,
// chosen to sit under a typical harness per-command timeout); expiring is NOT
// a failure: exit code 2 means "still running — call wait again".
async function cmdWait(opts) {
  const id = opts._[0] || null;
  const timeout = opts.timeout || '100s';
  const budget = durationToMs(timeout);
  if (budget == null) die(`invalid --timeout "${timeout}" (examples: 100s, 5m)`);

  const findJob = () => {
    const jobs = loadState().jobs || [];
    if (id) return jobs.find((j) => j.id === id) || null;
    return jobs.length ? jobs[jobs.length - 1] : null;
  };
  let job = findJob();
  if (!job) die(id ? `no job ${id} in this repository` : 'no pi-delegate jobs recorded in this repository');

  const POLL_MS = 100;
  const HEARTBEAT_MS = Number(process.env.PI_DELEGATE_HEARTBEAT_MS || 15_000);
  const start = Date.now();
  let lastBeat = start;
  let status = liveJobStatus(job);
  while (status === 'running' && Date.now() - start < budget) {
    await sleepMs(Math.min(POLL_MS, Math.max(0, budget - (Date.now() - start))));
    job = findJob();
    if (!job) die(`job record disappeared from state.json while waiting`);
    status = liveJobStatus(job);
    // Liveness on stderr so a long background wait stays observable without
    // ever mixing into the result on stdout.
    if (status === 'running' && Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stderr.write(`pi-delegate: still waiting on ${job.id} (${elapsed}s elapsed, budget ${timeout})\n`);
    }
  }

  if (status === 'running') {
    process.stdout.write(
      `Job ${job.id} (${job.mode}) is still running after ${timeout}.\n` +
        `Run \`wait ${job.id}\` again to keep waiting (exit code 2 means exactly this), or \`cancel ${job.id}\` to stop it.\n`
    );
    process.exitCode = JOB_EXIT_CODES.running;
    return;
  }

  // Terminal: safe to normalize the record persistently now — the worker is done.
  refreshJobs(loadState());
  job = findJob();
  status = job.status;

  if (fs.existsSync(job.result_file)) {
    process.stdout.write(`# Job ${job.id} (${job.mode}, ${status})\n\n`);
    process.stdout.write(fs.readFileSync(job.result_file, 'utf8'));
  } else {
    process.stdout.write(
      `Job ${job.id} (${job.mode}) finished with status ${status} and no stored result. Log: ${job.log_file}\n`
    );
  }
  process.exitCode = JOB_EXIT_CODES[status] ?? 1;
}

function cmdResult(opts) {
  const state = refreshJobs(loadState());
  const jobs = state.jobs || [];
  let job;
  if (opts._[0]) {
    job = jobs.find((j) => j.id === opts._[0]);
    if (!job) die(`no job ${opts._[0]} in this repository`);
  } else {
    job = [...jobs].reverse().find((j) => j.status !== 'running');
    if (!job) die('no finished jobs in this repository');
  }
  if (job.status === 'running') {
    die(`job ${job.id} is still running — collect it with \`wait ${job.id}\` or peek with \`status ${job.id}\``);
  }
  if (!fs.existsSync(job.result_file)) {
    die(`job ${job.id} (${job.status}) has no stored result. Log: ${job.log_file}`);
  }
  process.stdout.write(`# Job ${job.id} (${job.mode}, ${job.status})\n\n`);
  process.stdout.write(fs.readFileSync(job.result_file, 'utf8'));
}

function cmdCancel(opts) {
  const id = opts._[0];
  if (!id) die('cancel needs a job id (see `status`)');
  const state = loadState();
  const job = (state.jobs || []).find((j) => j.id === id);
  if (!job) die(`no job ${id} in this repository`);
  if (job.status !== 'running') {
    process.stdout.write(`Job ${id} is not running (status: ${job.status}).\n`);
    return;
  }
  // The worker is a detached session leader (its own process group), so
  // -pid kills the worker and the pi child it spawned in one shot.
  try {
    process.kill(-job.pid, 'SIGTERM');
  } catch {
    // already gone — the marker below still applies
  }
  withStateLock(() => {
    const state = loadState();
    const rec = (state.jobs || []).find((j) => j.id === id);
    if (rec) {
      rec.status = 'canceled';
      rec.finished_at = new Date().toISOString();
    }
    saveState(state);
  });
  process.stdout.write(`Canceled job ${id} (pid ${job.pid}).\n`);
}

// ---------------------------------------------------------------------------
// worker (detached job executor)
// ---------------------------------------------------------------------------

function cmdWorker(jobId) {
  const jobsDir = path.join(stateDir(), 'jobs');
  const spec = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.spec.json`), 'utf8'));
  const resultFile = path.join(jobsDir, `${jobId}.result.md`);

  const output = executeRun(spec.resolved);
  fs.writeFileSync(resultFile, output + '\n');
  withStateLock(() => {
    const state = loadState();
    const job = (state.jobs || []).find((j) => j.id === jobId);
    if (job) {
      job.status = 'done';
      job.finished_at = new Date().toISOString();
    }
    saveState(state);
  });
}

// die() exits the process, skipping the worker's failure bookkeeping. Patch
// exit inside the worker: convert nonzero exits into a throw, catch it, store
// the failure, and only then exit for real.
function workerMain(jobId) {
  const realExit = process.exit.bind(process);
  let stderrBuf = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrBuf += chunk;
    return origWrite(chunk, ...rest);
  };
  process.exit = (code) => {
    if (code) throw new Error(stderrBuf.trim() || `exit ${code}`);
    realExit(0);
  };
  try {
    cmdWorker(jobId);
  } catch (e) {
    const jobsDir = path.join(stateDir(), 'jobs');
    const resultFile = path.join(jobsDir, `${jobId}.result.md`);
    try {
      fs.writeFileSync(resultFile, `Job failed:\n${e?.message || e}\n`);
    } catch {
      // result dir may be unwritable; the state update below still applies
    }
    withStateLock(() => {
      const state = loadState();
      const job = (state.jobs || []).find((j) => j.id === jobId);
      if (job) {
        job.status = 'error';
        job.finished_at = new Date().toISOString();
      }
      saveState(state);
    });
    realExit(1);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    die(
      'usage: pi-delegate.mjs <run> [flags] "task"\n' +
        'flags: --sync --prompt-file <path> --stdin --continue --approve|--no-approve ' +
        '--readonly --model <id> --provider <name> --thinking <level> --timeout <dur> --no-session\n'
    );
  }
  if (cmd === '_worker') return workerMain(rest[0]);
  if (MODES.includes(cmd)) {
    const opts = parseFlags(rest);
    switch (cmd) {
      case 'run':
        return cmdRun(opts);
      case 'continue':
        return cmdContinue(opts);
      case 'status':
        return cmdStatus(opts);
      case 'result':
        return cmdResult(opts);
      case 'cancel':
        return cmdCancel(opts);
      case 'wait':
        return cmdWait(opts).catch((e) => die(e?.message || String(e)));
    }
  }
  if (cmd.startsWith('--')) return cmdRun(parseFlags(process.argv.slice(2))); // no subcommand: default run
  die(`unknown subcommand: ${cmd} (did you mean \`run\`?)`);
}

main();