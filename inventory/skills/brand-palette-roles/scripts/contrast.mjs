#!/usr/bin/env node
// Contrast checker: WCAG 2.2 ratio (the gate) and APCA Lc (second opinion) for text on background.
//
//   node contrast.mjs <text-hex> <background-hex> [<text-hex> <background-hex> ...] [--json]
//
// Exit 0 when every pair reaches WCAG AA for body text (4.5:1), 1 when one does not, 2 on bad input.
// Dependency-free; Node 18+.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normHex, contrastRatio, apcaLc } from './color.mjs';

export function checkPair(text, background) {
  const fg = normHex(text);
  const bg = normHex(background);
  const ratio = contrastRatio(fg, bg);
  const lc = apcaLc(fg, bg);
  const abs = Math.abs(lc);
  return {
    fg, bg,
    wcag: Math.floor(ratio * 100) / 100, // floored: WCAG never rounds a ratio up to a threshold
    aa: ratio >= 4.5, aaLarge: ratio >= 3, aaa: ratio >= 7, aaaLarge: ratio >= 4.5, nonText: ratio >= 3,
    apca: Number(lc.toFixed(1)),
    // APCA readability bands (|Lc|): 90 preferred body, 75 body, 60 content, 45 headlines, 30 non-text.
    apcaUse: abs >= 90 ? 'body (preferred)' : abs >= 75 ? 'body' : abs >= 60 ? 'content text' : abs >= 45 ? 'large text' : abs >= 30 ? 'non-text only' : 'not readable',
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const hexes = argv.filter((a) => a !== '--json');
  if (hexes.length === 0 || hexes.length % 2 !== 0) {
    process.stderr.write('usage: contrast.mjs <text-hex> <background-hex> [...pairs] [--json]\n');
    process.exitCode = 2;
    return;
  }
  let rows;
  try {
    rows = [];
    for (let i = 0; i < hexes.length; i += 2) rows.push(checkPair(hexes[i], hexes[i + 1]));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  else {
    for (const r of rows) {
      const level = r.aaa ? 'AAA' : r.aa ? 'AA' : r.aaLarge ? 'AA large/non-text only' : 'fails';
      process.stdout.write(`${r.fg} on ${r.bg}: ${r.wcag}:1 (${level}); APCA Lc ${r.apca} (${r.apcaUse})\n`);
    }
  }
  process.exitCode = rows.every((r) => r.aa) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
