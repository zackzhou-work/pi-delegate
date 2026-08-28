// Package smoke test: the plugin shells and skill must stay consistent with
// the companion they forward to, so a structural regression fails here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('plugin manifests parse and agree on names', () => {
  for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json']) {
    assert.doesNotThrow(() => readJson(rel), `${rel} must be valid JSON`);
  }
  assert.equal(readJson('.claude-plugin/plugin.json').name, 'pi');
  assert.equal(readJson('.codex-plugin/plugin.json').name, 'pi');
  assert.ok(readJson('.codex-plugin/plugin.json').skills, 'codex plugin must ship its skills dir');
});

test('the entry skill points at the real companion', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'pi', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: pi/m, 'skill must be the single entry point');
  assert.ok(skill.includes('companion/pi-delegate.mjs'), 'skill must resolve the companion');
  assert.ok(skill.includes('wait'), 'skill must carry the job collect contract');
  assert.ok(fs.existsSync(path.join(ROOT, 'companion', 'pi-delegate.mjs')), 'companion must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'templates', 'prompt.md')), 'guardrail template must exist');
});