import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, checkShowcaseData, validateShowcases } from '../lib/showcase.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

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
  const root = tempDir('skf-showcase-');
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
  const root = fixture({ 'known-skill': { 'showcase.json': JSON.stringify(valid()), 'shot.png': PNG } });
  assert.deepEqual(validateShowcases(root, new Set(['known-skill'])), []);
  assert.deepEqual(validateShowcases(tempDir('skf-none-'), new Set()), []);
});

test('invalid JSON and oversized images are errors', () => {
  const root = fixture({ 'known-skill': { 'showcase.json': '{', 'shot.png': 'x' } });
  assert.ok(validateShowcases(root, new Set(['known-skill'])).some((e) => /not valid JSON/.test(e)));
  const big = fixture({ 'known-skill': { 'showcase.json': JSON.stringify(valid()), 'shot.png': Buffer.alloc(513 * 1024) } });
  assert.ok(validateShowcases(big, new Set(['known-skill'])).some((e) => /larger than 512 KB/.test(e)));
});

test('links, stray entries, a missing showcase.json and fake images are errors', () => {
  const root = fixture({ 'known-skill': { 'showcase.json': JSON.stringify(valid()), 'shot.png': 'not a png' }, 'empty-skill': {} });
  fs.writeFileSync(path.join(root, 'showcase', 'notes.txt'), 'x');
  const outside = path.join(tempDir('skf-outside-'), 'secret.png');
  fs.writeFileSync(outside, PNG);
  const linked = fixture({ 'linked-skill': { 'showcase.json': JSON.stringify(valid()) } });
  fs.symlinkSync(outside, path.join(linked, 'showcase', 'linked-skill', 'shot.png'));
  const errors = validateShowcases(root, new Set(['known-skill', 'empty-skill']));
  assert.ok(errors.some((e) => /notes.txt is not a folder/.test(e)));
  assert.ok(errors.some((e) => /empty-skill has no showcase.json/.test(e)));
  assert.ok(errors.some((e) => /shot.png is not a png image/.test(e)));
  assert.ok(validateShowcases(linked, new Set(['linked-skill'])).some((e) => /shot.png is referenced but is not a file/.test(e)));
});

test('lengths that would overflow the Site layout and bidi controls are errors', () => {
  const data = valid();
  data.howItWorks.stages[0].name = 'x'.repeat(LIMITS.stageName + 1);
  data.howItWorks.stages[0].lines = ['y'.repeat(LIMITS.stageLine + 1)];
  data.inAction[2].swatches[0].name = 'z'.repeat(LIMITS.swatchName + 1);
  data.inAction[0].caption = 'reads \u202Ebackwards';
  data.workflow[0] = '收集 the seeds';
  data.howItWorks.stages[1].accent = 'yes';
  const many = valid();
  many.howItWorks.stages = Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, lines: ['x'], accent: true }));
  const manyErrors = [];
  checkShowcaseData(many, 'showcase/y', manyErrors);
  assert.ok(manyErrors.some((e) => /stages must be a list of 2 to 4/.test(e)));
  many.howItWorks.stages = many.howItWorks.stages.slice(0, 2);
  checkShowcaseData(many, 'showcase/y', manyErrors);
  assert.ok(manyErrors.some((e) => /more than one accent/.test(e)));
  const errors = [];
  checkShowcaseData(data, 'showcase/x', errors);
  for (const pattern of [/stages\[0\].name is longer/, /lines\[0\] is longer/, /swatches\[0\].name is longer/, /inAction\[0\].caption must be/, /workflow\[0\] must be in English/, /accent must be true or false/]) {
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in ${errors.join('; ')}`);
  }
});

test('the committed showcases are valid', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'registry.json'), 'utf8'));
  const names = new Set(registry.skills.filter((s) => s.type === 'skill' && s.installable !== false).map((s) => s.name));
  assert.deepEqual(validateShowcases(REPO_ROOT, names), []);
});
