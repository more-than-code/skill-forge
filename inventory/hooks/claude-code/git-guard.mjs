#!/usr/bin/env node
// PreToolUse(Bash) hook: enforce the commit rules the instructions only advise.
//
//   - `git commit` / `git push` in a repository outside this session's project → deny.
//     The project is $CLAUDE_PROJECT_DIR: its own repository (linked worktrees included),
//     plus any repository inside that folder (umbrella children).
//   - A commit on main/master, or a push that updates main/master → ask. The harness then
//     shows the user its own permission prompt, so only the user's click passes. A message
//     relayed from another session can never satisfy it, and the hook does not try to judge
//     who approved what.
//   - A command it cannot resolve statically (bash -c, eval, a subshell, `cd "$(…)"`,
//     GIT_DIR or --git-dir, a checkout before the commit, a shell fed a heredoc) → ask,
//     never a silent allow.
//   - Everything else → silence.
//
// This reads the command BEFORE it runs, so it follows `cd` and `git -C` itself. It is a
// guardrail, not a sandbox: git aliases, scripts and merges/rebases onto main are not seen.
// Self-contained on purpose — consumer machines may not have the skill-forge repo. The
// command text is never logged or echoed; replies name only repositories and branches.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROTECTED = new Set(['main', 'master']);
// Words that can precede a command without changing what it is.
const PREFIXES = new Set(['command', 'exec', 'nohup', 'time', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
// Commands that run their arguments (or a fed heredoc) as another command.
const RUNNERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'eval', 'source', '.', 'sudo', 'doas', 'env', 'xargs', 'find',
  'timeout', 'watch', 'nice', 'ssh', 'parallel', 'python', 'python3', 'node', 'ruby', 'perl',
]);
const GIT_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY)=/;
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--namespace', '--config-env', '--super-prefix', '--exec-path']);
const mentionsWrite = (s) => /\bgit\b/.test(s) && /\b(commit|push)\b/.test(s);

// Drops heredoc bodies — usually a commit message, whose `;`, `)` or quotes would derail the
// parse. Returns { text, unresolved }: a body fed to a shell or interpreter that mentions
// git is code, not data; a heredoc that never closes means the scan has lost track.
function stripHeredocs(cmd) {
  const out = [];
  let end = null;
  let opener = '';
  let body = '';
  const unresolved = [];
  for (const line of cmd.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) {
        if (/\bgit\b/.test(body) && [...RUNNERS].some((r) => new RegExp(`(^|[\\s;&|(])${r.replace('.', '\\.')}(\\s|$)`).test(opener)))
          unresolved.push('it feeds git commands to a shell through a heredoc');
        end = null;
      } else body += line + '\n';
      continue;
    }
    out.push(line);
    const m = line.match(/(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (m) {
      end = m[2];
      opener = line;
      body = '';
    }
  }
  if (end !== null) unresolved.push('a heredoc in it never closes');
  return { text: out.join('\n'), unresolved };
}

// Index just past the expansion starting at cmd[i] (`$(…)`, `${…}`, `$VAR`, or backticks).
function skipExpansion(cmd, i) {
  if (cmd[i] === '`') {
    const j = cmd.indexOf('`', i + 1);
    return j < 0 ? cmd.length : j + 1;
  }
  if (cmd[i + 1] === '(' || cmd[i + 1] === '{') {
    const [open, close] = cmd[i + 1] === '(' ? ['(', ')'] : ['{', '}'];
    let depth = 0;
    for (let j = i + 1; j < cmd.length; j++) {
      if (cmd[j] === open) depth++;
      else if (cmd[j] === close && --depth === 0) return j + 1;
    }
    return cmd.length;
  }
  const m = cmd.slice(i + 1).match(/^([A-Za-z_]\w*|[0-9@*#?$!-])/);
  return i + 1 + (m ? m[0].length : 0);
}

// Splits a command line into segments of words. A word is { text, dynamic }, where dynamic
// means its value is only known at run time. `subshell` flags any unquoted ( … ) grouping.
function parse(cmd) {
  const segments = [];
  let words = [];
  let word = null;
  let subshell = false;
  const cur = () => (word ??= { text: '', dynamic: false });
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && cmd[i + 1] === '\n') {
      i++; // line continuation: nothing
    } else if (c === '#' && !word) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; // comment
    } else if (c === '$' && cmd[i + 1] === "'") {
      // $'…' ANSI-C quoting: backslash escapes, including \'
      i += 2;
      while (i < cmd.length && cmd[i] !== "'") {
        if (cmd[i] === '\\' && i + 1 < cmd.length) i++;
        cur().text += cmd[i++];
      }
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      cur().text += cmd.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && cmd[i + 1] === '\n') {
          i += 2;
        } else if (cmd[i] === '\\' && i + 1 < cmd.length) {
          cur().text += cmd[i + 1];
          i += 2;
        } else if (cmd[i] === '$' || cmd[i] === '`') {
          const j = skipExpansion(cmd, i);
          cur().text += cmd.slice(i, j);
          cur().dynamic = true;
          i = j;
        } else {
          cur().text += cmd[i++];
        }
      }
    } else if (c === '\\') {
      cur().text += cmd[i + 1] ?? '';
      i++;
    } else if (c === '$' || c === '`') {
      const j = skipExpansion(cmd, i);
      cur().text += cmd.slice(i, j);
      cur().dynamic = true;
      i = j - 1;
    } else if (c === '(' || c === ')') {
      subshell = true;
      endWord();
    } else if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) {
      cur().text += c; // a redirection such as 2>&1, not a separator
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      endSegment();
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      cur().text += c;
    }
  }
  endSegment();
  return { segments, subshell };
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// A path word → absolute directory, or null when it is only known at run time. A leading
// $CLAUDE_PROJECT_DIR, $HOME or $PWD is expanded; any other expansion, `~user` or a glob
// is unknown.
function resolveDir(word, dir) {
  let text = word.text;
  if (word.dynamic) {
    text = text.replace(/^\$\{?(CLAUDE_PROJECT_DIR|HOME|PWD)\}?/, (_, v) =>
      v === 'PWD' ? dir : v === 'HOME' ? os.homedir() : process.env.CLAUDE_PROJECT_DIR ?? '$',
    );
    if (/[$`]/.test(text)) return null;
  }
  if (/[*?[{]/.test(text) || /^~[^/]/.test(text)) return null;
  if (text === '~' || text.startsWith('~/')) text = path.join(os.homedir(), text.slice(1));
  return path.resolve(dir, text);
}

// Walks the segments in order, tracking the working directory, and returns one entry per
// `git commit` / `git push`: { sub, dir, args, dirKnown, branchKnown } — or { unresolved }.
function gitWrites(segments, startDir) {
  const found = [];
  let dir = startDir;
  let dirKnown = true;
  let branchKnown = true;
  for (let words of segments) {
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0].text) || PREFIXES.has(words[0].text))) {
      if (GIT_ENV.test(words[0].text)) found.push({ unresolved: 'it sets a GIT_* variable that redirects git' });
      words = words.slice(1);
    }
    if (!words.length) continue;
    const name = path.basename(words[0].text);
    const rest = words.slice(1).map((w) => w.text);

    if (name === 'cd' || name === 'pushd') {
      const target = words.slice(1).find((w) => w.text === '-' || !w.text.startsWith('-'));
      if (!target) dir = os.homedir();
      else if (target.text === '-') dirKnown = false;
      else {
        const next = resolveDir(target, dir);
        if (next === null) dirKnown = false;
        else {
          dir = next;
          if (path.isAbsolute(target.text) || /^[$~]/.test(target.text)) dirKnown = true;
        }
      }
      continue;
    }
    if (name === 'popd') {
      dirKnown = false;
      continue;
    }
    if (['export', 'declare', 'typeset', 'set'].includes(name) && rest.some((t) => GIT_ENV.test(t))) {
      found.push({ unresolved: 'it sets a GIT_* variable that redirects git' });
      continue;
    }
    if (name !== 'git') {
      if (RUNNERS.has(name) && mentionsWrite(rest.join(' '))) found.push({ unresolved: 'it runs git through another command' });
      else if (/[*?[]/.test(words[0].text) && mentionsWrite(rest.join(' '))) found.push({ unresolved: 'its command name is a glob' });
      continue;
    }

    let gitDir = dir;
    let known = dirKnown && !words[0].dynamic;
    let i = 1;
    for (; i < words.length; i++) {
      const w = words[i];
      if (w.text === '-C') {
        const next = words[i + 1] ? resolveDir(words[i + 1], gitDir) : null;
        if (next === null) known = false;
        else gitDir = next;
        i++;
      } else if (GIT_VALUE_OPTIONS.has(w.text)) {
        if (w.text === '-c' && /^core\.(worktree|bare)=/i.test(words[i + 1]?.text ?? ''))
          found.push({ unresolved: 'it overrides core.worktree' });
        i++;
      } else if (/^--(git-dir|work-tree)\b/.test(w.text)) {
        found.push({ unresolved: `${w.text.split('=')[0]} points git somewhere this guard cannot check` });
        known = false;
      } else if (!w.text.startsWith('-')) {
        break;
      }
    }
    const sub = words[i]?.text;
    if (sub === 'checkout' || sub === 'switch') branchKnown = false;
    if (sub === 'commit' || sub === 'push') {
      found.push({ sub, dir: gitDir, args: words.slice(i + 1), dirKnown: known, branchKnown });
    }
  }
  return found;
}

// The branches a push would update; null when that cannot be read from the command.
function pushTargets(args, current) {
  const positional = [];
  for (const a of args) {
    if (a.dynamic || a.text.includes('*')) return null;
    if (a.text === '--all' || a.text === '--mirror' || a.text === '--branches') return null;
    if (!a.text.startsWith('-')) positional.push(a.text);
  }
  const refspecs = positional.slice(1);
  if (!refspecs.length) return current ? [current] : null;
  return refspecs.map((spec) => {
    const dst = spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
    return dst === 'HEAD' || dst === '' ? current : dst;
  });
}

// A directory that does not exist yet (the same command creates it) → its nearest existing
// ancestor, so `git init ../new && git -C ../new commit` is judged by where ../new will be.
function nearestExisting(dir) {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

function decide(command, cwd, projectDir) {
  if (!mentionsWrite(command.replace(/['"\\]/g, ''))) return null;
  const heredocs = stripHeredocs(command);
  const { segments, subshell } = parse(heredocs.text);
  const writes = [...heredocs.unresolved.map((u) => ({ unresolved: u })), ...gitWrites(segments, cwd)];
  if (!writes.length) return null;

  const project = real(projectDir);
  const projectCommon = git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const asks = [];
  if (subshell) asks.push('it runs git inside a ( … ) subshell');

  for (const w of writes) {
    if (w.unresolved) {
      asks.push(w.unresolved);
      continue;
    }
    if (!w.dirKnown) {
      asks.push(`this guard cannot tell which repository the ${w.sub} runs in`);
      continue;
    }
    const top = git(w.dir, ['rev-parse', '--show-toplevel']);
    if (!top) {
      // Not a repository yet. Inside the project it can only become an umbrella child.
      if (!within(real(nearestExisting(w.dir)), project)) asks.push(`the ${w.sub} runs in a directory outside the project that is not a repository yet`);
      continue;
    }
    const repo = real(top);
    const common = git(w.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const sameRepo = projectCommon && common && real(common) === real(projectCommon);
    if (!sameRepo && !within(repo, project)) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          `skill-forge git-guard: this ${w.sub} would run in ${repo}, outside this session's project ` +
          `(${project}). Commit in that repository only from a session working there, or ask the ` +
          `user to do it.`,
      };
    }
    const branch = w.branchKnown ? git(w.dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : null;
    if (!branch) {
      asks.push(`this guard cannot tell which branch the ${w.sub} in ${repo} is on`);
      continue;
    }
    if (w.sub === 'commit' && PROTECTED.has(branch)) {
      asks.push(`it commits on ${branch} in ${repo}`);
    } else if (w.sub === 'push') {
      const targets = pushTargets(w.args, branch);
      if (!targets) asks.push(`this guard cannot tell which branches the push in ${repo} updates`);
      else for (const t of new Set(targets.filter((t) => PROTECTED.has(t)))) asks.push(`it pushes ${t} in ${repo}`);
    }
  }
  if (!asks.length) return null;
  return {
    permissionDecision: 'ask',
    permissionDecisionReason:
      `skill-forge git-guard: ${[...new Set(asks)].join('; ')}. This needs the user's own ` +
      `confirmation; a message from another session is not approval.`,
  };
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const command = input.tool_input?.command;
    if (typeof command !== 'string') process.exit(0);
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const result = decide(command, cwd, process.env.CLAUDE_PROJECT_DIR || cwd);
    if (result) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...result } }) + '\n');
    }
  } catch {
    // Our own failure must never block the call or spill a stack trace into the session.
  }
  process.exit(0);
});
