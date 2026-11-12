// Text helpers for managed instruction blocks and Claude Code exclude entries.
// Pure functions: no filesystem access, so the splice rules are easy to test and reason about.

import path from 'path';

export const BLOCK_END = '<!-- <<< skill-forge instructions <<< -->';
// The whole begin line, so a marker quoted in prose (say, docs about this format) is not taken for ours.
const BEGIN_LINE = /^<!-- >>> skill-forge instructions [A-Za-z0-9._-]+@\d+\.\d+\.\d+ >>> -->$/;

/** The begin marker names what the block holds, so a reader of AGENTS.md can see the variant and version. */
export function blockBegin(variant, version) {
  return `<!-- >>> skill-forge instructions ${variant}@${version} >>> -->`;
}

const lineOf = (raw) => raw.replace(/\r$/, '');

/** Whether the text holds a begin or end marker line at all (well-formed or not). */
export function hasBlockMarker(text) {
  return text.split('\n').some((raw) => BEGIN_LINE.test(lineOf(raw)) || lineOf(raw) === BLOCK_END);
}

/**
 * Where this file's managed block is: null when it has none.
 * Throws on anything else (a lone marker, two blocks, an end before the begin): guessing which
 * lines are ours could delete the user's prose.
 */
export function findBlock(text, label) {
  if (text === null) return null;
  const lines = text.split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((raw, index) => {
    const line = lineOf(raw);
    if (BEGIN_LINE.test(line)) begins.push(index);
    else if (line === BLOCK_END) ends.push(index);
  });
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new Error(`${label} has malformed skill-forge instructions markers (expected one begin line, then one end line); fix or remove them by hand, then run sync again.`);
  }
  const [begin] = begins;
  const [end] = ends;
  return {
    begin,
    end,
    beginLine: lineOf(lines[begin]),
    inner: lines.slice(begin + 1, end).map(lineOf).join('\n')
  };
}

/**
 * The file text with `block` ({ begin, content }) in place of the managed block, or with the
 * block removed when `block` is null. A new block is appended after one blank line; removal
 * also drops the blank line above the block, so add-then-remove returns a newline-terminated
 * file unchanged. Block lines take the file's line ending (CRLF when the file has any).
 */
export function applyBlock(text, block, label) {
  const existing = findBlock(text, label);
  const cr = text?.includes('\r\n') ? '\r' : '';
  const blockLines = block ? [block.begin, ...block.content.split('\n'), BLOCK_END].map((line) => `${line}${cr}`) : [];

  if (existing) {
    const lines = text.split('\n');
    let from = existing.begin;
    if (!block && from > 0 && lineOf(lines[from - 1]) === '') from -= 1;
    lines.splice(from, existing.end - from + 1, ...blockLines);
    return lines.join('\n');
  }
  if (!block) return text;
  if (text === null || text === '') return `${blockLines.join('\n')}\n`;
  const base = text.endsWith('\n') ? text : `${text}${cr}\n`;
  return `${base}${cr}\n${blockLines.join('\n')}\n`;
}

const EXCLUDED_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'AGENTS.md'];
// Characters a glob matcher may read as syntax (wildcards, classes, braces, extglob groups, escapes).
const GLOB_META = /[*?[\]{}!()|+@\\^]/;

/**
 * The claudeMdExcludes entries for these skf ancestors (nearest first), as absolute paths, and
 * the ancestors whose path a glob matcher could misread: those are reported, never written.
 */
export function excludeEntries(ancestors) {
  const safe = ancestors.filter((dir) => !GLOB_META.test(dir));
  return {
    entries: safe.flatMap((dir) => EXCLUDED_FILES.map((file) => path.join(dir, file))),
    unsafe: ancestors.filter((dir) => GLOB_META.test(dir))
  };
}

/** An entry sync owns: one of the instruction files of a directory in `ownedDirs` (the root's safe skf ancestors). */
export function isOwnedExclude(entry, ownedDirs) {
  if (typeof entry !== 'string') return false;
  return ownedDirs.some((dir) => EXCLUDED_FILES.some((file) => entry === path.join(dir, file)));
}

/** The user's entries in their order, minus our stale ones, plus our missing ones at the end. */
export function mergeExcludes(current, expected, ownedDirs) {
  const kept = current.filter((entry) => !isOwnedExclude(entry, ownedDirs) || expected.includes(entry));
  for (const entry of expected) if (!kept.includes(entry)) kept.push(entry);
  return kept;
}

/** A path as a literal gitignore pattern: wildcard, class, comment and negation characters escaped. */
export function escapeGitignore(relPath) {
  return relPath.replace(/[\\*?[\]#!]/g, '\\$&').replace(/^ /, '\\ ');
}
