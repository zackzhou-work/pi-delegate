---
name: pi
description: Delegate a task to the local pi coding agent. Use when the user says /pi, "$pi", "let pi do X", "have pi handle X", or wants a second agent to implement, research, review, or answer something without spending this conversation's turn. One entry point, no personas — the task text shapes the output.
argument-hint: '[--sync] [--approve|--no-approve] [--readonly] [--model <id>] [--timeout <dur>] "task"'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

# pi delegate

Delegate a single task to the local pi agent. The call starts a background job and returns a job id; collecting the result is your job, not the user's.

## Invocation

```bash
node "<skill-dir>/../../companion/pi-delegate.mjs" run [flags] "task"
```

Run this command **unsandboxed** — pi needs `~/.pi/agent` (config, auth, sessions) and network. If the error mentions EPERM/EACCES on `~/.pi`, the command ran inside a sandbox; rerun with full permissions instead of retrying as-is.

Flags (all optional):

- `--sync` — foreground: the result prints in this call instead of starting a job
- `--prompt-file <path>` / `--stdin` — long task text (avoid shell quoting)
- `--approve` / `--no-approve` — override pi project trust for this run
- `--readonly` — pi gets only read/grep/find/ls; use for untrusted content
- `--model <id>` / `--provider <name>` / `--thinking <level>` — pass through to pi
- `--timeout <dur>` — job budget (default 10m)

Pass the user's task text through verbatim, and pass their explicit authorizations (e.g. "run the e2e tests") through verbatim too.

## Collecting the result

The job-start output prints the exact collect command (`wait <id> --timeout <n>m`). Run it as a **background command** — one background wait per job — and deliver the printed result when it exits 0. While it runs, heartbeat lines on stderr show liveness.

- **N jobs → N background waits, never one shell.** Do not wait for several ids serially in a single shell; start each job's own background wait the moment that job starts.
- Foreground fallback (nothing else to do, single job): rerun `wait <id>` with its 100s default while it exits 2.

Exit codes (`wait`, and `status <id>`): **0** = done (result printed), **2** = still running (same `wait` again), **3** = error/crashed, **4** = canceled, **1** = companion error. Never parse output to decide whether a job is done; branch on the exit code.

## Managing jobs

- `status [id]` — job table, or one job's JSON + log tail
- `result [id]` — re-print a finished job's stored output
- `cancel <id>` — stop a running job (wait then exits 4)
- `continue "follow-up"` — resume the most recent job's pi session (same flags as run; execution style follows run)

## Delivering the result

- Short result (about a screenful) → verbatim; a long one → the verdict/key points plus the result-file path (printed at job start), expanding on request.
- The result carries the working-tree report. If it says pi modified the tree, inspect the diff and ask the user whether to keep the changes before building on them. Rollback: `git checkout -- <path>`, or `git checkout .` for everything tracked.

## Failure protocol

- On any companion error (`wait` exit 1/3): quote its message verbatim, add one line of your own diagnosis and the suggested next step, then stop — do not retry with different flags unless the error itself names one.
- `no session file found...` from `continue`: the previous job never produced a pi session (e.g. it failed preflight) — tell the user and suggest resuming via a fresh `run`.