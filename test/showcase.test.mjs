import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkShowcaseData, validateShowcases } from '../lib/showcase.js';

const valid = () => ({
  value: 'Saves a team time.',
  howItWorks: { title: 'Two parts', stages: [{ name: 'In', lines: ['seeds'] }, { name: 'Out', lines: ['roles'], accent: true }] },
  workflow: ['Do one', 'Do two'],
  inAction: [
    { caption: 'A run', source: 'our site, 2026-11-28', image: { file: 'shot.png', alt: 'A screenshot' } },
    { caption: 'Output', source: 'script', excerpt: 'line one\nline two' },
    { caption: 'Colours', source: 'script', swatches: [{ name: 'brand', hex: '#E96800' }] }
  ]
});

function fixture(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skf-showcase-'));
  for (const [name, files] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, 'showcase', name), { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'showcase', name, file), body);
  }
  return root;
}

test('a complete showcase passes and returns its images', () => {
  const errors = [];
  assert.deepEqual(checkShowcaseData(valid(), 'showcase/x', errors), ['shot.png']);
  assert.deepEqual(errors, []);
});

test('unknown keys, missing sections and bad values are errors', () => {
  const data = valid();
  data.extra = 1;
  delete data.workflow;
  data.inAction[0].image.file = '../secret.png';
  data.inAction[2].swatches[0].hex = 'red';
  data.howItWorks.stages[0].name = 'bad\u0007name';
  const errors = [];
  checkShowcaseData(data, 'showcase/x', errors);
  for (const pattern of [/unknown key "extra"/, /workflow must be a list/, /image.file must be/, /hex must be #RRGGBB/, /stages\[0\].name must be/]) {
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in ${errors.join('; ')}`);
  }
});

test('an item needs exactly one of image, excerpt or swatches', () => {
  const data = valid();
  data.inAction[1].swatches = [{ name: 'a', hex: '#000000' }];
  const errors = [];
  checkShowcaseData(data, 'showcase/x', errors);
  assert.ok(errors.some((e) => /exactly one of/.test(e)));
});

test('folders must match a skill, images must exist, and stray files are errors', () => {
  const root = fixture({
    'known-skill': { 'showcase.json': JSON.stringify(valid()), 'stray.txt': 'x' },
    'unknown-skill': { 'showcase.json': JSON.stringify(valid()) }
  });
  const errors = validateShowcases(root, new Set(['known-skill']));
  assert.ok(errors.some((e) => /unknown-skill does not match/.test(e)));
  assert.ok(errors.some((e) => /known-skill\/shot.png is referenced but is not a file/.test(e)));
  assert.ok(errors.some((e) => /known-skill\/stray.txt is not referenced/.test(e)));
});

test('a folder with its images passes, and no showcase folder is fine', () => {
  const root = fixture({ 'known-skill': { 'showcase.json': JSON.stringify(valid()), 'shot.png': 'png' } });
  assert.deepEqual(validateShowcases(root, new Set(['known-skill'])), []);
  assert.deepEqual(validateShowcases(fs.mkdtempSync(path.join(os.tmpdir(), 'skf-none-')), new Set()), []);
});

test('invalid JSON and oversized images are errors', () => {
  const root = fixture({ 'known-skill': { 'showcase.json': '{', 'shot.png': 'x' } });
  assert.ok(validateShowcases(root, new Set(['known-skill'])).some((e) => /not valid JSON/.test(e)));
  const big = fixture({ 'known-skill': { 'showcase.json': JSON.stringify(valid()), 'shot.png': Buffer.alloc(513 * 1024) } });
  assert.ok(validateShowcases(big, new Set(['known-skill'])).some((e) => /larger than 512 KB/.test(e)));
});
