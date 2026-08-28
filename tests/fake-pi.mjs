#!/usr/bin/env node
// Fake pi CLI for black-box tests. Never talks to a real model or network.
//
// Behavior is driven by the FAKE_PI_SPEC env var (a JSON file path):
//   { "stdout": "...", "stderr": "...", "exitCode": 0,
//     "delayMs": 0, "argsFile": "/tmp/captured-args.json", "version": "pi 0.0.0-fake" }
// When argsFile is set, the received argv is written there so tests can
// assert exactly how the companion invoked pi.
import fs from 'node:fs';
import path from 'node:path';

const specFile = process.env.FAKE_PI_SPEC || '';
let spec = {};
if (specFile) {
  try {
    spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  } catch {
    // unreadable spec: fall through to default behavior
  }
}

if (process.argv.includes('--version')) {
  process.stdout.write(spec.version || 'pi 0.0.0-fake\n');
  process.exit(0);
}

if (spec.argsFile) {
  fs.writeFileSync(spec.argsFile, JSON.stringify(process.argv.slice(2), null, 2));
}

if (spec.delayMs) {
  // Blocking sleep that works inside spawnSync: wait on a shared buffer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.delayMs);
}

// Simulate pi editing the working tree: write/create a file under the cwd.
if (spec.mutateFile) {
  const p = path.join(process.cwd(), spec.mutateFile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, spec.mutateContent ?? 'mutated\n');
}

if (spec.stdout) process.stdout.write(spec.stdout);
if (spec.stderr) process.stderr.write(spec.stderr);
process.exit(spec.exitCode ?? 0);