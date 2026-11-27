#!/usr/bin/env node
// skf-cloud: Skill Forge for Claude Project threads and cloud sessions. Node 18+, built-ins only.
//
// Runs where `skf` is not installed: a cloud environment's setup script fetches this one file
// at a pinned registry commit and runs `install`; a thread runs `doctor`.
//
//   install  Write the declared rules, subagents and skills into ~/.claude. Reads the
//            declaration from SKF_REF, SKF_RULES, SKF_AGENTS, SKF_SKILLS and
//            SKF_PROJECT_RULES_FILE, then the skill-forge.json of every repository cloned in
//            SKF_REPOS_DIR (default: the working directory, /home/user in a setup script) and
//            installs each registry skill they declare once, unless SKF_SKILLS already provides
//            it (SKF_FROM_REPOS=0 turns that off). Logs to ~/skf-setup.log and always exits 0: a
//            failing setup script would stop threads from starting. A name or file that cannot
//            be installed is recorded as failed; everything else still installs.
//   install --top-up [--repos-dir <dir>]
//            Inside a running thread: re-read the repositories' skill-forge.json and add the
//            registry skills they declare that are not installed yet. Removes and replaces
//            nothing. Exits 1 when something could not be added.
//   doctor   Read-only. Checks the setup, the cloned repositories and (optionally) the
//            Project-instructions text, and prints findings with who fixes them and how.
//
// Trust model: SKF_REF is a full commit sha fetched over TLS from the public registry, so the
// commit authenticates everything, this file included. The sha256 values in
// registry-lock.json catch corruption in transit; they do not defend against a malicious ref.
// registry.json is not in the lock and is trusted by the same commit pin; its paths are still
// validated before use. Skill scripts are written without an executable bit: run them through
// their interpreter (`node x.mjs`, `python3 x.py`).
//
// Specs: tasks/spec-project-thread-setup.md and tasks/spec-manifest-skill-install.md in the
// skill-forge repository.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE = 'https://raw.githubusercontent.com/more-than-code/skill-forge';
const STATE_VERSION = 2;
const MANIFEST_NAME = 'skill-forge.json';
const MANIFEST_LOCK_NAME = 'skill-forge.lock.json';
const DEFAULT_REPOS_DIR = '/home/user';
// The managed .gitignore block of skf's "generated": "ignored" layout (bin/cli.js GITIGNORE_BLOCK_*).
const GENERATED_BLOCK_START = '# >>> skill-forge generated >>>';
const GENERATED_BLOCK_END = '# <<< skill-forge generated <<<';
const FETCH_TIMEOUT_MS = 20000;
const INSTALL_DEADLINE_MS = Number(process.env.SKF_DEADLINE_MS) || 90000;
const PROCESS_SKILLS = ['coding-discipline', 'security-baseline', 'code-quality', 'testing-strategy'];
const ALWAYS_USEFUL_SKILLS = [...PROCESS_SKILLS, 'claude-project-steward'];
const REPO_BYTES_BUDGET = 8 * 1024;
const REPO_READ_CAP = 256 * 1024;
const PROJECT_INSTRUCTIONS_LIMIT = 16000;
const OWNED_KINDS = ['rules', 'agents', 'skills'];
const BLOCK_BEGIN = /^<!-- >>> skill-forge instructions [A-Za-z0-9._-]+@\d+\.\d+\.\d+ >>> -->\r?$/m;
const MANAGED_BLOCK = /<!-- >>> skill-forge instructions[^\n]*\n[\s\S]*?<!-- <<< skill-forge instructions <<< -->/g;
// Phrases from the workstation (`full`) rules that contradict or repeat the cloud rules. A name
// such as `grok-bot-box` (a host) or a product's `grok` agent adapter is a repository fact, not the
// Grok workflow, so only Grok as a worker or build harness matches.
const WORKSTATION_PHRASES = [/tasks\/todo\.md/, /tasks\/lessons\.md/, /external[- ]worker/i, /\bgrok(?:-build-harness\b|[ -](?:workers?|build)\b)/i, /podman/i, /skf sync --check/];

const hashBytes = (bytes) => `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
const withoutManagedBlocks = (text) => text.replace(MANAGED_BLOCK, '');
const home = () => process.env.HOME || os.homedir();
const claudeDir = () => path.join(home(), '.claude');
const statePath = () => path.join(claudeDir(), 'skill-forge', 'state.json');
const logPath = () => path.join(home(), 'skf-setup.log');

// A plain relative path inside one package: no absolute paths, no "..", no empty segments.
const isSafeRelative = (rel) => typeof rel === 'string' && rel !== '' && !path.isAbsolute(rel) && !/[?#%\\]/.test(rel)
  && rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const isSafeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
// An install destination we may own: a file under ~/.claude/{rules,agents,skills}.
const isOwnedDest = (dest) => typeof dest === 'string' && path.isAbsolute(dest)
  && OWNED_KINDS.some((kind) => path.resolve(dest).startsWith(path.join(claudeDir(), kind) + path.sep));

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The recorded state, with anything that is not ours dropped (a tampered entry never steers a delete). */
function readState() {
  const raw = readJsonFile(statePath());
  if (!raw || typeof raw !== 'object') return null;
  const files = {};
  for (const [dest, hash] of Object.entries(raw.files && typeof raw.files === 'object' ? raw.files : {})) {
    if (isOwnedDest(dest) && typeof hash === 'string') files[dest] = hash;
  }
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const skills = strings(raw.skills);
  // Version 1 state has no sources: everything it installed came from SKF_SKILLS.
  const skillSources = {};
  for (const name of skills) skillSources[name] = 'env';
  for (const [name, source] of Object.entries(object(raw.skillSources))) {
    if (!isSafeName(name)) continue;
    if (source === 'env') skillSources[name] = 'env';
    else if (strings(source).length > 0) skillSources[name] = strings(source);
  }
  const skipped = {};
  for (const [name, entry] of Object.entries(object(raw.skipped))) {
    if (isSafeName(name) && typeof entry?.reason === 'string') {
      skipped[name] = {
        reason: entry.reason,
        repos: strings(entry.repos),
        detail: typeof entry.detail === 'string' ? entry.detail : '',
        version: typeof entry.version === 'string' ? entry.version : null
      };
    }
  }
  return {
    ref: typeof raw.ref === 'string' ? raw.ref : null,
    base: typeof raw.base === 'string' ? raw.base : DEFAULT_BASE,
    rules: typeof raw.rules === 'string' ? raw.rules : null,
    skills,
    fromRepos: raw.fromRepos === true,
    skillSources,
    skipped,
    failed: strings(raw.failed),
    versions: object(raw.versions),
    files
  };
}

/** Same rule as lib/skill-helpers.js satisfiesRange ("x.y.z", "^x.y.z", "~x.y.z"); null for a malformed range. */
function satisfiesRange(version, range) {
  const parse = (text) => (/^\d+\.\d+\.\d+$/.test(text) ? text.split('.').map(Number) : null);
  const trimmed = String(range).trim();
  const op = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '';
  const base = parse(op ? trimmed.slice(1) : trimmed);
  const actual = parse(String(version));
  if (!base) return null;
  if (!actual) return false;
  const compare = (actual[0] - base[0]) || (actual[1] - base[1]) || (actual[2] - base[2]);
  if (op === '') return compare === 0;
  if (compare < 0) return false;
  if (op === '~') return actual[0] === base[0] && actual[1] === base[1];
  if (base[0] > 0) return actual[0] === base[0];
  if (base[1] > 0) return actual[0] === 0 && actual[1] === base[1];
  return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2];
}

/** Whether a recorded skip still holds for the ranges the repos declare now (a range can be fixed by PR). */
function stillSkipped(skip, wants) {
  if (skip.reason !== 'range' || !skip.version) return true;
  return wants.some((want) => !satisfiesRange(skip.version, want.range));
}

/**
 * Repo-sourced skills with a failed fetch, hash check or write are dropped from the sources, so
 * top-up retries them instead of treating them as installed. SKF_SKILLS names stay: they are
 * the environment's, and D-setup-failed reports them.
 */
function dropFailedRepoSkills(skillSources, failed) {
  for (const [name, source] of Object.entries(skillSources)) {
    if (source !== 'env' && failed.some((entry) => entry.includes(`/skills/${name}/`))) delete skillSources[name];
  }
  return skillSources;
}

/**
 * A repository file parsed as JSON: undefined when absent, null when it is not a regular file
 * (a symlink, FIFO or device could leak or hang a root setup) or not valid JSON. Capped by readText.
 */
function readRepoJson(dir, name) {
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) return null;
  try {
    return JSON.parse(readText(file) ?? '');
  } catch {
    return null;
  }
}

/**
 * Registry skills the repositories declare: name -> [{ repo, range }]. `skills.local` entries are
 * the repository's own source and are left out. A missing manifest is normal; a malformed one,
 * a bad name or a bad range is logged and skipped so the other repositories still count.
 */
function readRepoNeeds(repos, log) {
  const needs = new Map();
  for (const repo of repos) {
    const manifest = readRepoJson(repo.dir, MANIFEST_NAME);
    if (manifest === undefined) continue;
    if (manifest === null) {
      log(`skipped ${repo.name}/${MANIFEST_NAME}: not a regular file of valid JSON`);
      continue;
    }
    const dependencies = manifest?.skills?.dependencies;
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      log(`skipped ${repo.name}/${MANIFEST_NAME}: skills.dependencies is not an object`);
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (!isSafeName(name) || typeof range !== 'string' || satisfiesRange('0.0.0', range) === null) {
        log(`skipped ${repo.name} dependency ${String(name).slice(0, 80)}: bad name or range`);
        continue;
      }
      if (!needs.has(name)) needs.set(name, []);
      needs.get(name).push({ repo: repo.name, range });
    }
  }
  return needs;
}

// --- install ---

/** Bytes of `rel` at `ref`: from a local mirror laid out as <base>/<ref>/<rel> (tests, offline) or over HTTPS. */
async function fetchBytes(base, ref, rel, deadline) {
  if (base.startsWith('/')) {
    const file = path.join(base, ref, rel);
    if (!file.startsWith(path.join(base, ref) + path.sep)) throw new Error('path outside the mirror');
    return fs.readFileSync(file);
  }
  if (!base.startsWith('https://')) throw new Error('SKF_BASE must be https:// or an absolute mirror path');
  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (deadline) signals.push(deadline);
  const response = await fetch(`${base}/${ref}/${rel}`, { signal: signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0] });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function readDeclaration(env) {
  const list = (value) => (value || '').split(/[\s,]+/).filter(Boolean);
  return {
    ref: env.SKF_REF || '',
    base: env.SKF_BASE || DEFAULT_BASE,
    rules: env.SKF_RULES || '',
    agents: env.SKF_AGENTS || '',
    skills: list(env.SKF_SKILLS),
    projectRulesFile: env.SKF_PROJECT_RULES_FILE || '',
    fromRepos: env.SKF_FROM_REPOS !== '0',
    reposDir: env.SKF_REPOS_DIR || process.cwd()
  };
}

/** Rendered variant blocks, exactly as the registry renders and locks them (cli.js renderInstructionVariant). */
function renderVariant(variant, sources) {
  const render = (text) => Object.entries(variant.vars || {})
    .reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value)), text).trimEnd();
  return { agents: render(sources.core), claude: sources.claude === null ? null : render(sources.claude) };
}

/**
 * Plans every file the declaration installs: { dest, content, label }. Only an unusable ref or
 * an unreadable registry throws; anything narrower lands in `failed` (with the destinations it
 * covers in `failedDests`, so a file installed earlier is kept rather than removed).
 */
async function planInstall(decl, previous, log, repoNeeds = new Map(), higher = new Set(decl.skills)) {
  if (!/^[0-9a-f]{40}$/.test(decl.ref)) throw new Error('SKF_REF must be a full 40-character registry commit sha');
  const deadline = AbortSignal.timeout(INSTALL_DEADLINE_MS);
  const get = (rel) => fetchBytes(decl.base, decl.ref, rel, deadline);
  const registry = JSON.parse((await get('registry.json')).toString('utf8'));
  const lock = JSON.parse((await get('registry-lock.json')).toString('utf8'));
  const packages = lock.packages || {};
  const planned = [];
  const failed = [];
  const failedDests = new Set();
  const versions = {};
  const fail = (what, reason, dests = []) => {
    failed.push(`${what} (${reason})`);
    for (const dest of dests) failedDests.add(dest);
    log(`FAILED ${what}: ${reason}`);
  };
  const ownedUnder = (dir) => Object.keys(previous?.files || {}).filter((dest) => dest.startsWith(dir + path.sep));

  const verified = async (rel, expected, dest, label) => {
    try {
      const bytes = await get(rel);
      if (hashBytes(bytes) !== expected) throw new Error('hash mismatch');
      planned.push({ dest, content: bytes, label });
    } catch (error) {
      fail(rel, error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timed out' : error.message, [dest]);
    }
  };
  /** Locked files of a package, each checked to be a plain relative path. */
  const lockedFiles = (what, locked, filter = () => true) => Object.entries(locked.files || {}).filter(([rel]) => {
    if (isSafeRelative(rel) && filter(rel)) return true;
    fail(`${what}/${String(rel).slice(0, 80)}`, 'unsafe path in the lock');
    return false;
  });

  if (decl.rules) {
    const dest = path.join(claudeDir(), 'rules', 'skill-forge.md');
    const variant = (registry.instructionVariants || []).find((entry) => entry.name === decl.rules);
    const locked = packages[`instructions:${decl.rules}`];
    if (!variant || !locked) {
      fail(`rules ${decl.rules}`, 'unknown variant', [dest]);
    } else if (!isSafeRelative(variant.core) || (variant.claude && !isSafeRelative(variant.claude))) {
      fail(`rules ${decl.rules}`, 'unsafe path in registry.json', [dest]);
    } else {
      try {
        const text = async (rel) => (await get(rel)).toString('utf8');
        const rendered = renderVariant(variant, { core: await text(variant.core), claude: variant.claude ? await text(variant.claude) : null });
        if (hashBytes(rendered.agents) !== locked.files?.['AGENTS.md']
          || (rendered.claude !== null && hashBytes(rendered.claude) !== locked.files?.['CLAUDE.md'])) {
          throw new Error('hash mismatch');
        }
        const body = [rendered.agents, rendered.claude].filter((part) => part !== null).join('\n\n');
        planned.push({ dest, content: Buffer.from(`${body}\n`), label: `rules ${decl.rules}@${variant.version}` });
        versions[`rules:${decl.rules}`] = variant.version;
      } catch (error) {
        fail(`rules ${decl.rules}`, error.message, [dest]);
      }
    }
  }

  if (decl.agents) {
    const artifact = (registry.managedSubagents || []).find((entry) => entry.scope === decl.agents);
    const locked = artifact && packages[artifact.path];
    if (!locked || !isSafeRelative(artifact.path) || !artifact.path.startsWith('inventory/subagents/')) {
      fail(`agents ${decl.agents}`, 'unknown subagent set', ownedUnder(path.join(claudeDir(), 'agents')));
    } else {
      versions[`agents:${decl.agents}`] = artifact.version;
      for (const [rel, expected] of lockedFiles(artifact.path, locked, (rel) => !rel.includes('/') && rel.endsWith('.md'))) {
        await verified(`${artifact.path}/${rel}`, expected, path.join(claudeDir(), 'agents', rel), `agent ${rel}`);
      }
    }
  }

  const lookupSkill = (name) => {
    const skill = isSafeName(name) ? (registry.skills || []).find((entry) => entry.name === name) : null;
    const locked = skill && skill.path === `inventory/skills/${name}` ? packages[skill.path] : null;
    if (!locked || skill.installable === false) return { problem: 'unknown or not installable' };
    if ((skill.tags || []).includes('workstation-only') || skill.workstationOnly === true) return { skill, problem: 'workstation-only' };
    return { skill, locked };
  };
  const planSkill = async ({ skill, locked }) => {
    versions[`skill:${skill.name}`] = skill.version;
    for (const [rel, expected] of lockedFiles(skill.path, locked)) {
      await verified(`${skill.path}/${rel}`, expected, path.join(claudeDir(), 'skills', skill.name, rel), `skill ${skill.name}`);
    }
  };

  const skillSources = {};
  for (const name of decl.skills) {
    const found = lookupSkill(name);
    const kept = isSafeName(name) ? ownedUnder(path.join(claudeDir(), 'skills', name)) : [];
    skillSources[name] = 'env';
    if (found.problem === 'workstation-only') {
      fail(`skill ${name}`, 'workstation-only; it does not belong in a cloud environment', kept);
    } else if (found.problem) {
      fail(`skill ${String(name).slice(0, 80)}`, found.problem, kept);
    } else {
      await planSkill(found);
    }
  }

  // Repo-declared skills a higher level does not provide: one copy each, at the version pinned
  // by SKF_REF, only when it satisfies every declaring repo's range. A skip is not a failure:
  // the repos asked for something this environment cannot give, and doctor says who fixes it.
  const skipped = {};
  for (const [name, wants] of [...repoNeeds].sort(([a], [b]) => a.localeCompare(b))) {
    if (higher.has(name)) continue;
    const repos = wants.map((want) => want.repo);
    const found = lookupSkill(name);
    const outside = found.skill ? wants.filter((want) => !satisfiesRange(found.skill.version, want.range)) : [];
    let reason = null;
    let detail = '';
    if (found.problem === 'workstation-only') {
      reason = 'workstation-only';
    } else if (found.problem) {
      reason = 'not-in-registry';
      detail = 'not an installable registry skill at SKF_REF';
    } else if (outside.length > 0) {
      reason = 'range';
      detail = `SKF_REF has ${found.skill.version}; ${outside.map((want) => `${want.repo} wants ${want.range}`).join(', ')}`;
    }
    if (reason) {
      skipped[name] = { reason, repos, detail, version: found.skill?.version ?? null };
      log(`skipped skill ${name} (${reason}${detail ? `: ${detail}` : ''})`);
      continue;
    }
    skillSources[name] = repos;
    await planSkill(found);
  }

  if (decl.projectRulesFile) {
    const dest = path.join(claudeDir(), 'rules', 'project.md');
    try {
      planned.push({ dest, content: fs.readFileSync(decl.projectRulesFile), label: 'project rules' });
    } catch (error) {
      fail('project rules', error.code || error.message, [dest]);
    }
  }
  return { planned, failed, failedDests, versions, skillSources, skipped };
}

/** Refuses a destination whose path below ~/.claude runs through a symlink (we never write through links). */
function assertNoSymlink(dest) {
  let current = claudeDir();
  for (const part of path.relative(claudeDir(), dest).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${current} is a symlink`);
  }
}

/** Writes via a temp file and rename, so an existing file is replaced, never written through. */
function writeAtomic(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.skf-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

/** Drops empty folders from `dir` up to, not including, ~/.claude/<kind>. */
function pruneEmptyDirs(dir) {
  const stop = OWNED_KINDS.map((kind) => path.join(claudeDir(), kind));
  let current = dir;
  while (!stop.includes(current) && current.startsWith(claudeDir() + path.sep)) {
    if (fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

/**
 * Writes the plan. A path is ours when the previous state recorded it. An existing path that is
 * not ours is left alone unless its bytes already match (then it is adopted); one of ours that
 * was edited since install is kept, not overwritten. Files we installed before and no longer
 * plan are removed only while their hash still matches, and never when this run failed to
 * fetch their replacement.
 */
function applyInstall(planned, previous, failedDests, log) {
  const owned = previous?.files || {};
  const files = {};
  const failed = [];
  for (const { dest, content, label } of planned) {
    const hash = hashBytes(content);
    try {
      assertNoSymlink(dest);
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      const current = existing === null ? null : hashBytes(existing);
      if (current !== null && current !== hash && owned[dest] === undefined) {
        log(`kept ${dest}: not installed by skill-forge`);
        continue;
      }
      if (current !== null && current !== hash && current !== owned[dest]) {
        log(`kept ${dest}: edited since install`);
        files[dest] = owned[dest];
        continue;
      }
      if (current !== hash) {
        writeAtomic(dest, content);
        log(`ok ${label} -> ${dest}`);
      }
      files[dest] = hash;
    } catch (error) {
      failed.push(`${dest} (${error.code || error.message})`);
      log(`FAILED write ${dest}: ${error.code || error.message}`);
      if (owned[dest] !== undefined) files[dest] = owned[dest];
    }
  }
  for (const [dest, hash] of Object.entries(owned)) {
    if (files[dest] !== undefined) continue;
    if (failedDests.has(dest)) {
      files[dest] = hash; // the replacement failed this run: keep the copy that worked
      continue;
    }
    try {
      assertNoSymlink(dest);
      if (!fs.existsSync(dest)) continue;
      if (hashBytes(fs.readFileSync(dest)) === hash) {
        fs.rmSync(dest);
        log(`removed ${dest} (no longer declared)`);
        pruneEmptyDirs(path.dirname(dest));
      } else {
        log(`kept ${dest}: edited since install`);
      }
    } catch (error) {
      log(`FAILED remove ${dest}: ${error.code || error.message}`);
    }
  }
  return { files, failed };
}

async function runInstall() {
  const lines = [];
  const log = (line) => lines.push(line);
  const decl = readDeclaration(process.env);
  log(`skf-cloud install ${new Date().toISOString()} ref=${decl.ref} rules=${decl.rules || '-'} agents=${decl.agents || '-'} skills=${decl.skills.join(',') || '-'} from-repos=${decl.fromRepos ? decl.reposDir : 'off'}`);
  try {
    const previous = readState();
    let needs = new Map();
    if (decl.fromRepos) {
      try {
        const repos = findRepos(decl.reposDir);
        log(`repos: ${repos.map((repo) => repo.name).join(', ') || 'none'}`);
        needs = readRepoNeeds(repos, log);
      } catch (error) {
        log(`FAILED reading repositories (installing the declaration only): ${error.code || error.message}`);
      }
    }
    const plan = await planInstall(decl, previous, log, needs);
    const applied = applyInstall(plan.planned, previous, plan.failedDests, log);
    const failed = [...plan.failed, ...applied.failed];
    dropFailedRepoSkills(plan.skillSources, failed);
    const state = {
      version: STATE_VERSION,
      ref: decl.ref,
      base: decl.base,
      rules: decl.rules || null,
      agents: decl.agents || null,
      skills: decl.skills,
      fromRepos: decl.fromRepos,
      skillSources: plan.skillSources,
      skipped: plan.skipped,
      projectRules: Boolean(decl.projectRulesFile),
      versions: plan.versions,
      failed,
      files: applied.files
    };
    writeAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
    log(failed.length === 0 ? 'done: all files verified' : `done with ${failed.length} failure(s)`);
  } catch (error) {
    log(`FAILED install: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
  }
  try {
    const self = process.argv[1];
    const selfDest = path.join(claudeDir(), 'skill-forge', 'skf-cloud.mjs');
    if (self && path.resolve(self) !== selfDest) writeAtomic(selfDest, fs.readFileSync(self));
  } catch (error) {
    log(`FAILED keeping a copy for doctor: ${error.code || error.message}`);
  }
  try {
    fs.writeFileSync(logPath(), `${lines.join('\n')}\n`);
  } catch {
    // Nothing else can report it; setup must still not fail.
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Adds the registry skills the repositories declare now but the setup did not install (a
 * manifest changed after the environment snapshot was built). Uses the recorded SKF_REF, so it
 * adds what a fresh setup would; everything already installed counts as the higher level, so
 * nothing is replaced or removed.
 */
async function runTopUp(args) {
  const lines = [];
  const log = (line) => lines.push(line);
  const index = args.indexOf('--repos-dir');
  const reposDir = (index >= 0 ? args[index + 1] : undefined) || process.env.SKF_REPOS_DIR || DEFAULT_REPOS_DIR;
  const state = readState();
  log(`skf-cloud install --top-up ${new Date().toISOString()} repos-dir=${reposDir}`);
  let failed = [];
  if (!state?.ref) {
    failed = ['no install recorded'];
    log(`FAILED top-up: no ${statePath()}; the environment's setup script has not run install`);
  } else {
    try {
      const repos = findRepos(reposDir);
      const needs = readRepoNeeds(repos, log);
      const higher = new Set(Object.keys(state.skillSources));
      const missing = [...needs].filter(([name, wants]) => !higher.has(name)
        && !(Object.hasOwn(state.skipped, name) && stillSkipped(state.skipped[name], wants)));
      if (!state.fromRepos) {
        log('nothing changed: this environment does not install repo-declared skills (SKF_FROM_REPOS=0, or a setup from before that feature)');
      } else if (missing.length === 0) {
        log('nothing to add: every declared skill is installed');
      } else {
        // The source is the environment's (SKF_BASE) or the public registry, never state.json's.
        const decl = { ref: state.ref, base: process.env.SKF_BASE || DEFAULT_BASE, rules: '', agents: '', skills: [], projectRulesFile: '' };
        const plan = await planInstall(decl, null, log, new Map(missing), higher);
        const applied = applyInstall(plan.planned, null, new Set(), log);
        failed = [...plan.failed, ...applied.failed];
        const added = Object.keys(dropFailedRepoSkills(plan.skillSources, failed));
        const skillSources = { ...state.skillSources, ...plan.skillSources };
        for (const [name, source] of Object.entries(skillSources)) {
          if (source !== 'env' && needs.has(name)) skillSources[name] = needs.get(name).map((want) => want.repo);
        }
        // Skips are kept only for names still declared; a name added now is no longer skipped.
        const skipped = Object.fromEntries(Object.entries({ ...state.skipped, ...plan.skipped })
          .filter(([name]) => needs.has(name) && !added.includes(name)));
        const earlier = state.failed.filter((entry) => !added.some((name) => entry.includes(`/skills/${name}/`)));
        const next = {
          ...readJsonFile(statePath()),
          version: STATE_VERSION,
          skillSources,
          skipped,
          versions: { ...state.versions, ...plan.versions },
          failed: [...new Set([...earlier, ...failed])],
          files: { ...state.files, ...applied.files }
        };
        writeAtomic(statePath(), `${JSON.stringify(next, null, 2)}\n`);
        log(`added: ${added.join(', ') || 'none'}${Object.keys(plan.skipped).length > 0 ? `; skipped: ${Object.keys(plan.skipped).join(', ')}` : ''}`);
      }
    } catch (error) {
      failed = [error.message];
      log(`FAILED top-up: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
    }
  }
  try {
    fs.appendFileSync(logPath(), `${lines.join('\n')}\n`);
  } catch {
    // The output below still reports it.
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

// --- doctor ---

const OWNERS = ['owner-paste', 'owner-account', 'thread-pr', 'thread', 'skill-forge'];

function finding(id, severity, owner, evidence, fix) {
  return { id, severity, owner, evidence, fix };
}

/** Repositories cloned for this thread: git work trees directly under the repos directory. */
function findRepos(reposDir) {
  const root = path.resolve(reposDir);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => {
      const dir = path.join(root, entry.name);
      let linkedDir = false;
      try {
        linkedDir = entry.isSymbolicLink() && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory();
      } catch {
        // A looping or unreadable link is not a repository.
      }
      return (entry.isDirectory() || linkedDir) && fs.existsSync(path.join(dir, '.git'));
    })
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A file's text, capped so a hostile repo cannot make doctor slow; null when absent. */
function readText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(REPO_READ_CAP);
      const length = fs.readSync(fd, buffer, 0, REPO_READ_CAP, 0);
      return buffer.subarray(0, length).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The always-loaded text of a repo: CLAUDE.md plus the files inside the repo it imports with @path. */
function loadedRepoText(dir) {
  const claude = readText(path.join(dir, 'CLAUDE.md'));
  if (claude === null) return { claude: null, text: '', importsAgents: false };
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    realDir = dir;
  }
  let text = claude;
  let importsAgents = false;
  for (const match of claude.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
    const target = match[1].replace(/^\.\//, '');
    if (target === 'AGENTS.md') importsAgents = true;
    let real;
    try {
      real = fs.realpathSync(path.resolve(dir, target));
    } catch {
      continue;
    }
    if (real.startsWith(realDir + path.sep)) text += `\n${readText(real) ?? ''}`;
  }
  return { claude, text, importsAgents };
}

/** `## heading` sections with their bodies, for spotting the same section in two repos. */
function sections(text) {
  const result = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      current = { heading: line.slice(3).trim(), body: [] };
      result.push(current);
    } else if (/^#{1,6} |^<!-- [<>]{3} skill-forge instructions/.test(line)) {
      current = null; // any other heading or a managed-block marker ends the section
    } else if (current) {
      current.body.push(line);
    }
  }
  return result.map(({ heading, body }) => ({ heading, body: body.join('\n').trim() })).filter((entry) => entry.body.length > 40);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function logTail() {
  const text = readText(logPath());
  return text ? text.trim().split('\n').filter((line) => line.startsWith('FAILED')).slice(-3).join(' | ') : '';
}

function checkSetup(findings) {
  const state = readState();
  if (!state) {
    const tail = logTail();
    findings.push(finding('D-setup-missing', 'issue', 'owner-paste', `no ${statePath()}: the environment's setup script has no Skill Forge declaration, or it failed${tail ? ` (${tail})` : ''}`,
      'Paste the Skill Forge declaration into the Project environment\'s setup script (the steward drafts it), then start a new thread.'));
    return null;
  }
  if (state.failed.length > 0) {
    findings.push(finding('D-setup-failed', 'issue', 'owner-paste', `the last install could not install: ${state.failed.join('; ')}`,
      `Check ${logPath()}; usually a wrong name in SKF_SKILLS, a wrong SKF_REF or a network block. Fix the declaration and start a new thread.`));
  }
  for (const [file, hash] of Object.entries(state.files)) {
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (bytes === null || hashBytes(bytes) !== hash) {
      findings.push(finding('D-setup-tampered', 'issue', 'owner-paste', `${file} is ${bytes === null ? 'missing' : 'changed'} since install`,
        'Start a new thread (the setup snapshot restores it); if it persists, re-save the setup script to rebuild the snapshot.'));
    }
  }
  return state;
}

/** Whether semver `a` is newer than `b` (numeric major.minor.patch; anything else is never newer). */
function isNewer(a, b) {
  const parse = (version) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Compares the pinned versions with the registry's `main`, so a Project learns its SKF_REF is behind. */
async function checkRefBehind(findings, state, offline) {
  if (offline || !state?.ref || Object.keys(state.versions).length === 0) return;
  let latest;
  try {
    latest = JSON.parse((await fetchBytes(state.base, 'main', 'registry.json', AbortSignal.timeout(FETCH_TIMEOUT_MS))).toString('utf8'));
  } catch (error) {
    findings.push(finding('D-ref-unchecked', 'note', 'thread', `could not read the registry's main branch (${error.message})`, 'Re-run doctor with network access, or pass --offline.'));
    return;
  }
  const current = (key) => {
    const [kind, name] = key.split(':');
    if (kind === 'skill') return (latest.skills || []).find((entry) => entry.name === name)?.version;
    if (kind === 'rules') return (latest.instructionVariants || []).find((entry) => entry.name === name)?.version;
    if (kind === 'agents') return (latest.managedSubagents || []).find((entry) => entry.scope === name)?.version;
    return undefined;
  };
  const behind = Object.entries(state.versions)
    .filter(([key, version]) => typeof version === 'string' && isNewer(current(key), version))
    .map(([key, version]) => `${key} ${version} -> ${current(key)}`);
  if (behind.length > 0) {
    findings.push(finding('D-ref-behind', 'note', 'owner-paste', `the pinned SKF_REF is behind the registry: ${behind.join(', ')}`,
      'Update SKF_REF in the setup script to the registry\'s current main commit (the steward drafts it), then start a new thread.'));
  }
}

/**
 * Lists the registry skills at SKF_REF that nothing installs or declares, as a prompt for the
 * thread's agent to match against the repositories' stacks (docs/SKILL-SUGGESTIONS.md). Doctor
 * detects no stack itself; the agent judges and opens a PR in the repo for a clear fit.
 */
async function checkSuggestions(findings, state, repos, offline) {
  if (offline || !state?.ref) return;
  let registry;
  try {
    registry = JSON.parse((await fetchBytes(state.base, state.ref, 'registry.json', AbortSignal.timeout(FETCH_TIMEOUT_MS))).toString('utf8'));
  } catch (error) {
    findings.push(finding('D-skill-suggest-unchecked', 'note', 'thread', `could not read the registry at ${state.ref} to list skills to suggest (${error.message})`,
      'Re-run doctor with network access, or pass --offline.'));
    return;
  }
  const taken = new Set(listDir(path.join(claudeDir(), 'skills')));
  for (const name of readRepoNeeds(repos, () => {}).keys()) taken.add(name);
  for (const repo of repos) {
    const local = readRepoJson(repo.dir, MANIFEST_NAME)?.skills?.local;
    if (local && typeof local === 'object') for (const name of Object.keys(local)) taken.add(name);
    for (const name of listDir(path.join(repo.dir, '.claude', 'skills'))) taken.add(name);
  }
  const candidates = (Array.isArray(registry.skills) ? registry.skills : [])
    .filter((skill) => skill && isSafeName(String(skill.name)) && skill.path === `inventory/skills/${skill.name}`
      && skill.installable !== false && /^\d+\.\d+\.\d+$/.test(String(skill.version)) && skill.workstationOnly !== true
      && !(Array.isArray(skill.tags) && skill.tags.includes('workstation-only')) && !taken.has(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length === 0) return;
  const tags = (skill) => (Array.isArray(skill.tags) ? skill.tags.filter((tag) => typeof tag === 'string' && isSafeName(tag)) : []);
  const listed = candidates.map((skill) => `${skill.name} ${skill.version}${tags(skill).length > 0 ? ` [${tags(skill).join(', ')}]` : ''}`);
  const urls = candidates.map((skill) => `${skill.name} ^${skill.version} ${state.base}/${state.ref}/${skill.path}/SKILL.md`);
  findings.push(finding('D-skill-suggest', 'note', 'thread', `${candidates.length} registry skill(s) are neither installed nor declared by a repo: ${listed.join(', ')}`,
    'Check whether any of these skills fits a cloned repository\'s stack. Look at each repo\'s dependency and config files '
    + '(package.json including devDependencies, go.mod, pubspec.yaml, pyproject.toml, Dockerfile, deploy config), including apps in subfolders. '
    + 'For a skill whose name or tags fit, read its description at the URL below. Where it clearly applies, open a PR in that repo adding '
    + `"<name>": "^<version>" to ${MANIFEST_NAME} skills.dependencies (create {"schemaVersion": 2, "skills": {"dependencies": {}}} if the repo has none); `
    + 'after it merges, run: node ~/.claude/skill-forge/skf-cloud.mjs install --top-up. Suggest nothing that only loosely fits. '
    + `If the repo belongs to another Project, tell the owner instead of opening the PR. Skills (name, range, description): ${urls.join('; ')}`));
}

/**
 * For a committed `.claude/skills` symlink, the repo-relative folder it points at ("" is never
 * returned). null: not a symlink (a real folder, or absent). undefined: a link that is absolute,
 * leaves the repository, dangles or has unusual characters; doctor never lists through it.
 */
function linkedSkillsTarget(repoDir, skillsDir) {
  let link;
  try {
    if (!fs.lstatSync(skillsDir).isSymbolicLink()) return null;
    link = fs.readlinkSync(skillsDir);
  } catch {
    return null;
  }
  if (link.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(link) || path.isAbsolute(link)) return undefined;
  try {
    const repoReal = fs.realpathSync(repoDir);
    const real = fs.realpathSync(skillsDir);
    if (!real.startsWith(repoReal + path.sep)) return undefined;
    const target = path.relative(repoReal, real).split(path.sep).join('/');
    // The resolved folder goes into a suggested command and a .gitignore block: plain names only.
    return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

function checkRepos(findings, repos, state) {
  const envSkills = new Set(listDir(path.join(claudeDir(), 'skills')));
  const envAgents = new Set(listDir(path.join(claudeDir(), 'agents')).filter((name) => name.endsWith('.md')));
  const declaredByRepos = new Map();
  const sectionOwners = new Map();
  let profiles = 0;

  for (const repo of repos) {
    const loaded = loadedRepoText(repo.dir);
    const agentsText = readText(path.join(repo.dir, 'AGENTS.md'));
    if (loaded.claude === null) {
      if (agentsText !== null) {
        findings.push(finding('D-repo-no-claude-md', 'issue', 'thread-pr', `${repo.name} has AGENTS.md but no CLAUDE.md, so threads load none of it`,
          `PR in ${repo.name}: add CLAUDE.md containing the single line @AGENTS.md (into the default branch, or the branch the Project instructions name).`));
      }
    } else if (agentsText !== null && !loaded.importsAgents) {
      findings.push(finding('D-repo-claude-no-import', 'issue', 'thread-pr', `${repo.name}/CLAUDE.md does not import AGENTS.md`,
        `PR in ${repo.name}: add the line @AGENTS.md to CLAUDE.md.`));
    }
    const text = loaded.text;
    const prose = withoutManagedBlocks(text);
    if (BLOCK_BEGIN.test(text)) {
      findings.push(finding('D-repo-managed-block', state ? 'issue' : 'note', 'thread-pr', `${repo.name} carries a Skill Forge managed instructions block, which repeats the environment's workflow rules`,
        `PR in ${repo.name}: remove the block and the "instructions" variant keys in skill-forge.json, and keep only ${repo.name}'s own facts.`));
    }
    const phrases = WORKSTATION_PHRASES.filter((pattern) => pattern.test(prose));
    if (phrases.length > 0) {
      findings.push(finding('D-repo-restates-rules', 'note', 'thread-pr', `${repo.name} instructions mention workstation-only workflow (${phrases.map(String).join(', ')})`,
        `PR in ${repo.name}: drop workflow rules the environment already carries; keep repository facts.`));
    }
    if (Buffer.byteLength(text) > REPO_BYTES_BUDGET) {
      findings.push(finding('D-repo-size', 'issue', 'thread-pr', `${repo.name} loads ${Buffer.byteLength(text)} bytes of instructions in every thread (budget ${REPO_BYTES_BUDGET})`,
        `PR in ${repo.name}: shorten CLAUDE.md and its imports to repository facts; every repo's files load in every thread.`));
    }
    // An AGENTS.md that is not loaded yet (no CLAUDE.md) will be once the import is added.
    for (const { heading, body } of sections(loaded.claude === null ? withoutManagedBlocks(agentsText ?? '') : prose)) {
      const key = `${heading}\n${body}`;
      if (!sectionOwners.has(key)) sectionOwners.set(key, []);
      sectionOwners.get(key).push(repo.name);
    }
    const profile = readRepoJson(repo.dir, MANIFEST_NAME);
    const ownSkills = profile?.skills?.local && typeof profile.skills.local === 'object' ? profile.skills.local : {};
    const skillsDir = path.join(repo.dir, '.claude', 'skills');
    const target = linkedSkillsTarget(repo.dir, skillsDir);
    // A link that leaves the repo (or cannot be read) commits no copies; never list through it.
    const listed = target === undefined ? [] : listDir(skillsDir);
    const copies = listed.filter((name) => envSkills.has(name) && !Object.hasOwn(ownSkills, name));
    // Under the explicit-list setup (SKF_FROM_REPOS=0 or an older one) a copy may be the only source a local session has.
    const copySeverity = state?.fromRepos ? 'issue' : 'note';
    if (target && copies.length > 0) {
      // skf sync's claude-code shim: one committed link to the vendored folder, so one finding with one fix.
      const own = Object.keys(ownSkills).filter(isSafeName).sort();
      // Registry copies the repo declares (installed in threads or not, such as workstation-only ones)
      // are generated like the rest; only a folder that is neither declared nor the repo's own needs a decision.
      const deps = profile?.skills?.dependencies && typeof profile.skills.dependencies === 'object' ? profile.skills.dependencies : {};
      const generated = listed.filter((name) => (copies.includes(name) || Object.hasOwn(deps, name)) && !own.includes(name)).sort();
      const leftovers = listed.filter((name) => !generated.includes(name) && !own.includes(name)).sort();
      const skfLayout = target === '.agents/skills' && Object.entries(ownSkills)
        .every(([name, rel]) => isSafeName(name) && String(rel).replace(/\/+$/, '') === `${target}/${name}`);
      let fix;
      if (skfLayout) {
        // Skill Forge's "generated": "ignored" layout, written out because a thread has no skf.
        const lines = [GENERATED_BLOCK_START, `/${target}/*`, ...own.map((name) => `!/${target}/${name}/`), GENERATED_BLOCK_END];
        fix = `PR in ${repo.name}: set "generated": "ignored" in ${MANIFEST_NAME}; append these lines to .gitignore, one per line, exactly: ${lines.map((line) => `"${line}"`).join(', ')}; untrack the registry copies with git rm -r --cached -- ${generated.map((name) => `${target}/${name}`).join(' ')}; keep the .claude/skills link, ${MANIFEST_LOCK_NAME} and the repo's own skills${own.length > 0 ? ` (${own.join(', ')})` : ''}.${leftovers.length > 0 ? ` Also settle ${leftovers.map((name) => `${target}/${name}`).join(', ')}: declare each in skills.local at that path, or remove it (the block would ignore it).` : ''} A workstation checkout then runs skf sync once (skf with "generated" support).`;
      } else if (listed.length === copies.length) {
        fix = `PR in ${repo.name}: git rm the .claude/skills symlink and ${target}/, and add "/.claude/skills" and "/${target}/" to .gitignore; keep ${MANIFEST_NAME} and its lock. After pulling it, a workstation checkout runs skf sync once to get its local copies back (then ignored).`;
      } else {
        fix = `PR in ${repo.name}: keep the .claude/skills symlink (${target}/ also holds skills the environment does not install); git rm -r -- ${copies.map((name) => `${target}/${name}/`).join(' ')} and add each, with a leading /, to .gitignore; keep ${MANIFEST_NAME} and its lock.`;
      }
      findings.push(finding('D-repo-vendored-skill', copySeverity, 'thread-pr', `${repo.name} commits .claude/skills as a symlink to ${target}/, so threads list ${copies.length} skill(s) the environment also installs again as ${repo.name}:<name> (the environment copy runs): ${copies.join(', ')}`, fix));
    } else {
      for (const name of copies) {
        findings.push(finding('D-repo-vendored-skill', copySeverity, 'thread-pr', `${repo.name} commits skill ${name}, which the environment also installs; threads list it again as ${repo.name}:${name} (the environment copy runs)`,
          `PR in ${repo.name}: delete .claude/skills/${name}/ (and .agents/skills/${name}/), add both paths to .gitignore, keep ${MANIFEST_NAME} and its lock; a local skf sync still writes the copies, now ignored.`));
      }
    }
    for (const name of listDir(path.join(repo.dir, '.claude', 'agents'))) {
      if (envAgents.has(name)) {
        findings.push(finding('D-repo-agent-shadow', 'issue', 'thread-pr', `${repo.name}/.claude/agents/${name} overrides the environment's ${name} (project agents win)`,
          `PR in ${repo.name}: remove .claude/agents/${name}, or rename it if it is meant to differ.`));
      }
    }
    if (profile) profiles += 1;
    if (!state) continue;
    const variant = profile?.instructions?.variant;
    if (typeof variant === 'string' && isSafeName(variant) && state.rules && variant !== state.rules) {
      findings.push(finding('D-rules-variant-differs', 'note', 'thread-pr', `${repo.name} declares instructions variant ${variant}; threads load the environment's ${state.rules} instead`,
        `Nothing to do for threads. If ${repo.name} is only worked on in this Project, a PR can declare ${state.rules} so local sessions match.`));
    }
    const locked = readRepoJson(repo.dir, MANIFEST_LOCK_NAME)?.skills;
    for (const [name, entry] of Object.entries(locked && typeof locked === 'object' ? locked : {})) {
      const installed = Object.hasOwn(state.versions, `skill:${name}`) ? state.versions[`skill:${name}`] : undefined;
      if (isSafeName(name) && entry?.source === 'registry' && typeof entry.version === 'string' && /^\d+\.\d+\.\d+$/.test(entry.version)
        && typeof installed === 'string' && entry.version !== installed) {
        findings.push(finding('D-skill-version-drift', 'note', 'thread-pr', `${repo.name} locks ${name} ${entry.version}; threads run ${installed} (from SKF_REF)`,
          `Usually nothing: the version satisfies ${repo.name}'s range. To match, a PR in ${repo.name} re-locks with skf sync, or the owner moves SKF_REF.`));
      }
    }
  }

  // The same validated reading install uses, so doctor and install agree on what is declared.
  const wants = readRepoNeeds(repos, () => {});
  for (const [name, list] of wants) declaredByRepos.set(name, [...new Set(list.map((want) => want.repo))]);

  for (const [key, owners] of sectionOwners) {
    if (owners.length > 1) {
      findings.push(finding('D-repo-duplicate-section', 'issue', 'thread-pr', `section "${key.split('\n')[0]}" appears in ${owners.join(', ')}; every repo's instructions load in every thread`,
        'Keep it once: Project-wide rules go in the Project instructions, the rest in one repo.'));
    }
  }
  if (!state) return;
  const workstationOnly = new Map();
  for (const [name, owners] of declaredByRepos) {
    if (envSkills.has(name)) continue;
    const repoHasIt = owners.some((owner) => fs.existsSync(path.join(repos.find((repo) => repo.name === owner).dir, '.claude', 'skills', name)));
    const recorded = state.fromRepos && Object.hasOwn(state.skipped, name) ? state.skipped[name] : undefined;
    const skip = recorded && stillSkipped(recorded, wants.get(name) || []) ? recorded : undefined;
    // Recorded as installed but absent: the install failed, and D-setup-failed already says so.
    if (state.fromRepos && !skip && Object.hasOwn(state.skillSources, name)) continue;
    if (skip?.reason === 'workstation-only') {
      const key = owners.join(', ');
      if (!workstationOnly.has(key)) workstationOnly.set(key, []);
      workstationOnly.get(key).push(name);
    } else if (skip?.reason === 'not-in-registry') {
      findings.push(finding('D-skill-range', 'issue', 'thread-pr', `skill ${name} declared by ${owners.join(', ')} is not installed: ${skip.detail}`,
        `PR in ${owners.join(', ')}: correct the name in ${MANIFEST_NAME} or drop it; if it is a newer registry skill, the owner moves SKF_REF instead.`));
    } else if (skip) {
      findings.push(finding('D-skill-range', 'issue', 'owner-paste', `skill ${name} declared by ${owners.join(', ')} is not installed: ${skip.detail || skip.reason}`,
        `Move SKF_REF to a registry commit whose ${name} satisfies every range (the steward drafts it), or a PR changes the range in the repo; then start a new thread.`));
    } else if (state.fromRepos && !repoHasIt) {
      findings.push(finding('D-skill-missing', 'issue', 'thread', `skill ${name} is declared by ${owners.join(', ')} but not installed (the manifest changed after the environment was built)`,
        'Run: node ~/.claude/skill-forge/skf-cloud.mjs install --top-up. The next environment rebuild installs it for every thread.'));
    } else if (!state.fromRepos && owners.length > 1) {
      findings.push(finding('D-skill-shared-not-installed', 'note', 'owner-paste', `skill ${name} is declared by ${owners.join(', ')} but not installed by the environment`,
        `Add ${name} to SKF_SKILLS in the setup script.`));
    } else if (!state.fromRepos && !repoHasIt) {
      findings.push(finding('D-skill-missing', 'issue', 'owner-paste', `skill ${name} is declared by ${owners.join(', ')} but neither the environment nor the repo provides it`,
        `Add ${name} to SKF_SKILLS, or commit it in ${owners[0]}.`));
    }
  }
  // One note per declaring set of repos, not one per skill: a workstation profile can list many.
  for (const [key, names] of workstationOnly) {
    const plural = !key.includes(', ');
    findings.push(finding('D-skill-workstation-only', 'note', 'thread-pr', `${key} declare${plural ? 's' : ''} ${names.length} workstation-only skill(s), not installed in threads: ${names.sort().join(', ')}`,
      `Nothing to do: local sessions still use them. Drop one from ${MANIFEST_NAME} only if no local session needs it.`));
  }
  // A repo-sourced skill (installed at setup or by --top-up) whose repos all stopped declaring it.
  // Only when every recorded repo is cloned here: one that is not may still declare it.
  const cloned = new Set(repos.map((repo) => repo.name));
  for (const [name, source] of Object.entries(state.fromRepos ? state.skillSources : {})) {
    if (!Array.isArray(source) || declaredByRepos.has(name) || !source.every((repo) => cloned.has(repo))) continue;
    // A manifest that does not parse may still declare it (a thread mid-edit): say nothing.
    if (source.some((owner) => readRepoJson(repos.find((repo) => repo.name === owner).dir, MANIFEST_NAME) === null)) continue;
    findings.push(finding('D-skill-repo-leftover', 'note', 'thread', `skill ${name} was installed for ${source.join(', ')}, which no longer declare${source.length === 1 ? 's' : ''} it; it stays in ~/.claude/skills in this thread`,
      'Nothing to do: the next environment rebuild drops it.'));
  }
  if (profiles === 0) return;
  for (const name of state.skills) {
    if (!declaredByRepos.has(name) && !ALWAYS_USEFUL_SKILLS.includes(name)) {
      findings.push(finding('D-skill-unused', 'note', 'owner-paste', `the environment installs ${name}, which no repo profile declares`,
        `Drop ${name} from SKF_SKILLS unless threads need it.`));
    }
  }
}

function checkContext(findings, file) {
  const text = readText(file);
  if (text === null) {
    findings.push(finding('D-context-unreadable', 'issue', 'thread', `cannot read ${file}`, 'Write the Project instructions text to a file and pass it with --context.'));
    return;
  }
  if (text.length > PROJECT_INSTRUCTIONS_LIMIT) {
    findings.push(finding('D-context-size', 'issue', 'owner-paste', `Project instructions are ${text.length} characters (limit ${PROJECT_INSTRUCTIONS_LIMIT})`, 'Shorten them to Project-level rules.'));
  }
  const namesBase = text.split('\n').some((line) => line.length < 2000 && /\b(PRs?|pull requests?)\b.*\binto\s+`?[\w./-]+/i.test(line));
  if (!namesBase) {
    findings.push(finding('D-context-pr-base', 'issue', 'owner-paste', 'the Project instructions name no pull-request base branch; threads then use the repo default',
      'Add a line such as: Pull requests go into `dev`.'));
  }
  const phrases = WORKSTATION_PHRASES.filter((pattern) => pattern.test(text));
  if (phrases.length > 0 || /\b(risk tiers?|Tier 1|Quality Gates)\b/.test(text)) {
    findings.push(finding('D-context-restates-rules', 'note', 'owner-paste', 'the Project instructions restate engineering workflow rules the environment already carries',
      'Keep only Project-level rules there (repo ownership, thread scope, approvals, PR base).'));
  }
}

async function runDoctor(args) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const reposDir = option('--repos-dir') || process.env.SKF_REPOS_DIR || DEFAULT_REPOS_DIR;
  const findings = [];
  const state = checkSetup(findings);
  await checkRefBehind(findings, state, args.includes('--offline'));
  const repos = findRepos(reposDir);
  checkRepos(findings, repos, state);
  await checkSuggestions(findings, state, repos, args.includes('--offline'));
  const context = option('--context');
  if (context) checkContext(findings, context);
  const report = { version: 1, ref: state?.ref ?? null, repos: repos.map((repo) => repo.name), findings };

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const out = [`skf-cloud doctor: ref ${report.ref ?? 'none'}, repos ${report.repos.join(', ') || 'none'}`];
    if (findings.length === 0) out.push('No findings.');
    for (const owner of OWNERS) {
      const group = findings.filter((entry) => entry.owner === owner);
      if (group.length === 0) continue;
      out.push('', `[${owner}]`);
      for (const entry of group) out.push(`- ${entry.severity.toUpperCase()} ${entry.id}: ${entry.evidence}`, `  fix: ${entry.fix}`);
    }
    process.stdout.write(`${out.join('\n')}\n`);
  }
  if (args.includes('--check') && findings.some((entry) => entry.severity === 'issue')) process.exitCode = 1;
}

process.stdout.on('error', () => {});
const [command, ...rest] = process.argv.slice(2);
if (command === 'install' && rest.includes('--top-up')) {
  await runTopUp(rest);
} else if (command === 'install') {
  await runInstall();
} else if (command === 'doctor') {
  await runDoctor(rest);
} else {
  process.stderr.write('usage: skf-cloud.mjs install [--top-up [--repos-dir <dir>]] | doctor [--repos-dir <dir>] [--context <file>] [--offline] [--json] [--check]\n');
  process.exitCode = 2;
}
