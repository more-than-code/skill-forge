#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import {
  RANGE_PATTERN,
  SEMVER_PATTERN,
  assertNoDuplicateRelPaths,
  assertPathWithinInventorySkills as assertPathWithinInventorySkillsAt,
  assertSafeRelativePath,
  assertSkillMdStdinAvailable,
  bumpSemver,
  canonicalizeSkillRelPath,
  isSkillMdRelPath,
  parseSemver,
  satisfiesRange
} from '../lib/skill-helpers.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SKILL_FORGE_ROOT is an internal/test override so mutator tests can isolate
// registry + inventory without touching the developer checkout.
const REPO_ROOT = process.env.SKILL_FORGE_ROOT
  ? path.resolve(process.env.SKILL_FORGE_ROOT)
  : path.join(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry.json');
const REGISTRY_LOCK_PATH = path.join(REPO_ROOT, 'registry-lock.json');
const SCOPE_PRIORITY = ['custom'];
const ARTIFACT_TYPES = ['skills', 'agents', 'subagents', 'hooks'];
const TOOL_LABELS = {
  codex: 'Codex',
  'copilot-cli': 'Copilot CLI',
  'claude-code': 'Claude Code',
  grok: 'Grok'
};
const ARTIFACT_TYPE_ALIASES = {
  skill: 'skills',
  skills: 'skills',
  agent: 'agents',
  agents: 'agents',
  subagent: 'subagents',
  subagents: 'subagents',
  hook: 'hooks',
  hooks: 'hooks'
};
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// Present as the invoked bin name; default to the short alias for hints.
const CLI_NAME = ['skill-forge', 'skf'].includes(path.basename(process.argv[1] || ''))
  ? path.basename(process.argv[1])
  : 'skf';
const PROJECT_MANIFEST_NAME = 'skill-forge.json';
const PROJECT_LOCK_NAME = 'skill-forge.lock.json';
const PROJECT_TOOLS = ['codex', 'claude-code', 'copilot-cli', 'grok'];
const PROJECT_NEUTRAL_SKILL_DIR = path.join('.agents', 'skills');
const TOOL_PROJECT_SKILL_DIRS = { 'claude-code': path.join('.claude', 'skills') };

const program = new Command();

program
  .name(CLI_NAME)
  .description('CLI to manage skills from the skill-forge registry')
  .version('1.3.0');

function expandHome(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath === '~') return process.env.HOME;
  if (targetPath.startsWith('~/')) return path.join(process.env.HOME, targetPath.slice(2));
  return targetPath;
}

async function readRegistry() {
  return fs.readJson(REGISTRY_PATH);
}

async function writeRegistry(registry) {
  await fs.writeJson(REGISTRY_PATH, registry, { spaces: 2 });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function splitTags(value) {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function toSkillSummary(skill) {
  return {
    name: skill.name,
    version: skill.version,
    scope: skill.scope,
    tags: skill.tags || [],
    installable: skill.installable,
    path: skill.path,
    runtimeTarget: skill.runtimeTarget
  };
}

async function readSkillDescription(skill) {
  const body = await fs.readFile(path.join(REPO_ROOT, skill.path, 'SKILL.md'), 'utf8').catch(() => '');
  const frontmatter = parseFrontmatter(body) || {};
  return frontmatter.description || '';
}

function parseFileAssignment(raw) {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(`Invalid --file "${raw}"; expected <relative-path>=<local-source-path>.`);
  }
  const relPath = canonicalizeSkillRelPath(assertSafeRelativePath(raw.slice(0, eq), '--file path'));
  const localPath = raw.slice(eq + 1);
  return { relPath, localPath };
}

async function assertLocalSourceFile(relPath, localPath) {
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat) throw new Error(`--file "${relPath}=${localPath}": local source not found.`);
  if (!stat.isFile()) throw new Error(`--file "${relPath}=${localPath}": local source must be a regular file.`);
}

async function pruneEmptyParents(dir, skillDir) {
  let current = dir;
  while (current !== skillDir) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fs.remove(current);
    current = path.dirname(current);
  }
}

function assertPathWithinInventorySkills(relPath) {
  return assertPathWithinInventorySkillsAt(relPath, REPO_ROOT);
}

function printSkillError(options, message, extra = {}) {
  if (options?.json) {
    console.log(JSON.stringify({ error: message, ...extra }, null, 2));
  } else {
    console.error(chalk.red(message));
  }
  process.exitCode = 1;
}

function skillKey(skill) {
  if (skill.scope === 'custom') return skill.name;
  return `${skill.scope}/${skill.name}`;
}

function artifactKey(artifact, type) {
  if (type === 'skills') return skillKey(artifact);
  return artifact.name;
}

function sortSkills(skills) {
  return [...skills].sort((a, b) => {
    const aPriority = SCOPE_PRIORITY.includes(a.scope) ? SCOPE_PRIORITY.indexOf(a.scope) : SCOPE_PRIORITY.length;
    const bPriority = SCOPE_PRIORITY.includes(b.scope) ? SCOPE_PRIORITY.indexOf(b.scope) : SCOPE_PRIORITY.length;
    const scopeDiff = aPriority - bPriority;
    return scopeDiff || a.name.localeCompare(b.name);
  });
}

function getSkillEntries(registry, { installableOnly = false } = {}) {
  return sortSkills(registry.skills.filter((skill) => {
    if (installableOnly && !skill.installable) return false;
    return true;
  }));
}

function resolveSkill(registry, requested) {
  const skills = registry.skills;
  const scoped = requested.includes('/');

  if (scoped) {
    const [scope, name, extra] = requested.split('/');
    const match = !extra && scope === 'custom'
      ? skills.find((skill) => skill.scope === 'custom' && skill.name === name)
      : skills.find((skill) => skillKey(skill) === requested);
    return { skill: match, ambiguous: false };
  }

  const matches = sortSkills(skills.filter((skill) => skill.name === requested));
  return {
    skill: matches[0],
    ambiguous: matches.length > 1,
    matches
  };
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const data = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const simple = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!simple) continue;

    const [, key, rawValue] = simple;
    if (rawValue === '>') {
      const folded = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!/^\s+/.test(lines[next])) break;
        folded.push(lines[next].trim());
      }
      data[key] = folded.join(' ');
    } else {
      data[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }

  return data;
}

async function listFilesRecursive(rootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath);
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

async function hashTree(absolutePath) {
  const stat = await fs.stat(absolutePath);
  const files = {};

  if (stat.isDirectory()) {
    for (const filePath of await listFilesRecursive(absolutePath)) {
      const relativeFile = path.relative(absolutePath, filePath);
      files[relativeFile] = await hashFile(filePath);
    }
  } else {
    files[path.basename(absolutePath)] = await hashFile(absolutePath);
  }

  const treeInput = Object.entries(files)
    .map(([file, hash]) => `${file}\0${hash}`)
    .join('\n');
  const integrity = `sha256-${crypto.createHash('sha256').update(treeInput).digest('base64')}`;
  return { files, integrity };
}

async function buildPackageEntry(artifact) {
  const { files, integrity } = await hashTree(path.join(REPO_ROOT, artifact.path));

  const entry = {
    name: artifact.name,
    version: artifact.version,
    type: artifact.type,
    scope: artifact.scope,
    installable: artifact.installable,
    runtimeTarget: artifact.runtimeTarget,
    integrity,
    files
  };
  if (artifact.sourceOnly === true) entry.sourceOnly = true;
  return entry;
}

async function hashBytes(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

async function buildLock(registry) {
  const packages = {
    '': {
      name: registry.name,
      version: registry.version
    }
  };

  for (const skill of sortSkills(registry.skills)) {
    packages[skill.path] = await buildPackageEntry(skill);
  }

  for (const artifact of [
    ...(registry.managedAgents || []),
    ...(registry.managedSubagents || []),
    ...(registry.managedHooks || [])
  ]) {
    const absolutePath = path.join(REPO_ROOT, artifact.path);
    const stat = await fs.stat(absolutePath);
    const packagePath = stat.isDirectory() ? artifact.path : path.dirname(artifact.path);
    packages[packagePath] = await buildPackageEntry(artifact);
  }

  return {
    name: registry.name,
    version: registry.version,
    lockfileVersion: 1,
    requires: true,
    packages
  };
}

async function writeLock({ silent = false } = {}) {
  const registry = await readRegistry();
  const lock = await buildLock(registry);
  await fs.writeJson(REGISTRY_LOCK_PATH, lock, { spaces: 2 });
  if (!silent) console.log(chalk.green(`Wrote ${path.relative(process.cwd(), REGISTRY_LOCK_PATH)}`));
}

function reportValidationError(errors, message) {
  errors.push(message);
}

async function validateRegistry() {
  const errors = [];
  const warnings = [];
  const registry = await readRegistry();

  if (!registry.name) reportValidationError(errors, 'registry.json missing name');
  if (!registry.version) reportValidationError(errors, 'registry.json missing version');
  if (!Array.isArray(registry.skills)) reportValidationError(errors, 'registry.json missing skills array');
  if (!Array.isArray(registry.managedAgents)) reportValidationError(errors, 'registry.json missing managedAgents array');
  if (registry.managedSubagents && !Array.isArray(registry.managedSubagents)) {
    reportValidationError(errors, 'registry.json managedSubagents must be an array');
  }

  const skillKeys = new Set();
  const names = new Map();

  for (const skill of registry.skills || []) {
    const key = skillKey(skill);
    if (skillKeys.has(key)) reportValidationError(errors, `duplicate skill key ${key}`);
    skillKeys.add(key);
    names.set(skill.name, [...(names.get(skill.name) || []), key]);

    if (!skill.name) reportValidationError(errors, `skill at ${skill.path} missing name`);
    if (!skill.version) reportValidationError(errors, `${key} missing version`);
    if (!skill.scope) reportValidationError(errors, `${key} missing scope`);
    if (!skill.path) reportValidationError(errors, `${key} missing path`);
    if (!Object.prototype.hasOwnProperty.call(skill, 'installable')) reportValidationError(errors, `${key} missing installable`);
    if (!Object.prototype.hasOwnProperty.call(skill, 'runtimeTarget')) reportValidationError(errors, `${key} missing runtimeTarget`);

    const skillFile = path.join(REPO_ROOT, skill.path || '', 'SKILL.md');
    if (!await fs.pathExists(skillFile)) {
      reportValidationError(errors, `${key} missing SKILL.md at ${skill.path}`);
      continue;
    }

    const frontmatter = parseFrontmatter(await fs.readFile(skillFile, 'utf8'));
    if (!frontmatter) {
      reportValidationError(errors, `${key} missing YAML frontmatter`);
      continue;
    }
    for (const field of ['name', 'description']) {
      if (!frontmatter[field]) reportValidationError(errors, `${key} frontmatter missing ${field}`);
    }
    if (frontmatter.name && frontmatter.name !== skill.name) {
      reportValidationError(errors, `${key} frontmatter name ${frontmatter.name} does not match registry name`);
    }
    if (frontmatter.version) {
      reportValidationError(errors, `${key} frontmatter must not include version; keep versions in registry.json`);
    }
  }

  for (const [name, keys] of names.entries()) {
    if (keys.length > 1) warnings.push(`${name} exists in multiple scopes: ${keys.join(', ')}`);
  }

  for (const artifact of [
    ...(registry.managedAgents || []),
    ...(registry.managedSubagents || []),
    ...(registry.managedHooks || [])
  ]) {
    for (const field of ['name', 'version', 'path']) {
      if (!artifact[field]) reportValidationError(errors, `managed artifact missing ${field}`);
    }
    if (!artifact.sourceOnly && !artifact.runtimeTarget) {
      reportValidationError(errors, `${artifact.name} missing runtimeTarget`);
    }
    if (artifact.path && !await fs.pathExists(path.join(REPO_ROOT, artifact.path))) {
      reportValidationError(errors, `${artifact.name} missing file at ${artifact.path}`);
    }
  }

  const agentCore = getAgentCore(registry);
  if (agentCore) {
    const coreSource = await fs.readFile(path.join(REPO_ROOT, agentCore.path), 'utf8');
    for (const artifact of (registry.managedAgents || []).filter((entry) => !entry.sourceOnly)) {
      if (!artifact.path || !await fs.pathExists(path.join(REPO_ROOT, artifact.path))) continue;
      const composed = await composeAgentContent(registry, artifact);
      const unresolved = findUnresolvedPlaceholders(composed);
      if (unresolved.length > 0) {
        reportValidationError(errors, `${artifact.name} has unresolved placeholders: ${unresolved.map((name) => `{{${name}}}`).join(', ')}; add them to the artifact's vars in registry.json`);
      }
      const source = coreSource + await fs.readFile(path.join(REPO_ROOT, artifact.path), 'utf8');
      for (const varName of Object.keys(artifact.vars || {})) {
        if (!source.includes(`{{${varName}}}`)) warnings.push(`${artifact.name} defines unused var ${varName}`);
      }
    }
  }

  if (registry.profiles !== undefined) {
    if (typeof registry.profiles !== 'object' || Array.isArray(registry.profiles)) {
      reportValidationError(errors, 'registry.json profiles must be an object of profile name -> { skill: range }');
    } else {
      for (const [profileName, entries] of Object.entries(registry.profiles)) {
        if (typeof entries !== 'object' || Array.isArray(entries)) {
          reportValidationError(errors, `profile "${profileName}" must map skill names to ranges`);
          continue;
        }
        for (const [name, range] of Object.entries(entries)) {
          const { skill } = resolveSkill(registry, name);
          if (!skill || !skill.installable) {
            reportValidationError(errors, `profile "${profileName}" references unknown or non-installable skill "${name}"`);
          }
          if (typeof range !== 'string' || !RANGE_PATTERN.test(range)) {
            reportValidationError(errors, `profile "${profileName}" skill "${name}" has invalid range "${range}"`);
          }
        }
      }
    }
  }

  if (await fs.pathExists(REGISTRY_LOCK_PATH)) {
    const expected = JSON.stringify(await buildLock(registry), null, 2);
    const actual = JSON.stringify(await fs.readJson(REGISTRY_LOCK_PATH), null, 2);
    if (expected !== actual) reportValidationError(errors, 'registry-lock.json is stale; run `skill-forge lock`');
  }

  return { errors, warnings };
}

async function diffArtifact(artifact, label) {
  if (!artifact.runtimeTarget) return { status: 'skip', label, reason: 'no runtime target' };

  const registry = await readRegistry();
  const sourcePath = path.join(REPO_ROOT, artifact.path);
  const targetPath = expandHome(artifact.runtimeTarget);
  if (!await fs.pathExists(targetPath)) return { status: 'missing', label, targetPath };

  if (artifact.type === 'agents') {
    const sourceContent = await composeAgentContent(registry, artifact);
    const targetContent = await fs.readFile(targetPath);
    const sourceIntegrity = await hashBytes(sourceContent);
    const targetIntegrity = await hashBytes(targetContent);
    return {
      status: sourceIntegrity === targetIntegrity ? 'clean' : 'diff',
      label,
      targetPath,
      sourceIntegrity,
      targetIntegrity
    };
  }

  const sourceEntry = await buildPackageEntry({ ...artifact, runtimeTarget: null });
  const targetEntry = await buildPackageEntry({
    ...artifact,
    path: path.relative(REPO_ROOT, targetPath),
    runtimeTarget: null
  });

  return {
    status: sourceEntry.integrity === targetEntry.integrity ? 'clean' : 'diff',
    label,
    targetPath,
    sourceIntegrity: sourceEntry.integrity,
    targetIntegrity: targetEntry.integrity
  };
}

function printDiffResult(result) {
  if (result.status === 'skip') {
    console.log(chalk.gray(`- ${result.label}: skipped (${result.reason})`));
  } else if (result.status === 'clean') {
    console.log(chalk.green(`- ${result.label}: clean`));
  } else if (result.status === 'missing') {
    console.log(chalk.yellow(`- ${result.label}: missing ${result.targetPath}`));
  } else {
    console.log(chalk.yellow(`- ${result.label}: differs`));
    console.log(chalk.gray(`  source ${result.sourceIntegrity}`));
    console.log(chalk.gray(`  target ${result.targetIntegrity}`));
  }
}

function getArtifactsByType(registry, type) {
  if (type === 'skills') return getSkillEntries(registry, { installableOnly: true });
  if (type === 'agents') return (registry.managedAgents || []).filter((artifact) => !artifact.sourceOnly);
  if (type === 'subagents') return registry.managedSubagents || [];
  if (type === 'hooks') return registry.managedHooks || [];
  return [];
}

function getToolChoices(registry) {
  const seen = new Set();
  const choices = [];

  if ((registry.skills || []).some((skill) => skill.installable)) {
    seen.add('codex');
    choices.push({
      name: TOOL_LABELS.codex,
      value: 'codex'
    });
  }

  for (const artifact of [
    ...(registry.managedAgents || []),
    ...(registry.managedSubagents || []),
    ...(registry.managedHooks || [])
  ].filter((entry) => entry.runtimeTarget)) {
    if (seen.has(artifact.scope)) continue;
    seen.add(artifact.scope);
    choices.push({
      name: TOOL_LABELS[artifact.scope] || artifact.scope,
      value: artifact.scope
    });
  }

  return choices;
}

function normalizeArtifactType(type) {
  return ARTIFACT_TYPE_ALIASES[type] || type;
}

function filterArtifactsForTarget(type, artifacts, target) {
  if (type === 'skills') {
    return artifacts;
  }
  return artifacts.filter((artifact) => artifact.scope === target);
}

function resolveArtifactFromList(type, artifacts, requested) {
  if (type === 'skills') {
    const resolved = resolveSkill({ skills: artifacts }, requested);
    return {
      artifact: resolved.skill,
      ambiguous: resolved.ambiguous,
      matches: resolved.matches
    };
  }

  const matches = artifacts.filter((artifact) => artifact.name === requested || artifactKey(artifact, type) === requested);
  return {
    artifact: matches[0],
    ambiguous: matches.length > 1,
    matches
  };
}

function getAvailableArtifactTypes(registry, target) {
  return ARTIFACT_TYPES.filter((type) => filterArtifactsForTarget(type, getArtifactsByType(registry, type), target).length > 0);
}

async function chooseTool(registry, providedTarget) {
  const choices = getToolChoices(registry);
  if (providedTarget) {
    const targets = choices.map((choice) => choice.value);
    if (!targets.includes(providedTarget)) {
      throw new Error(`Unsupported target "${providedTarget}". Use one of: ${targets.join(', ')}`);
    }
    return providedTarget;
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'target',
      message: 'Select target tool:',
      choices
    }
  ]);
  return answer.target;
}

async function chooseArtifactType(providedType, availableTypes = ARTIFACT_TYPES) {
  if (providedType) {
    const type = normalizeArtifactType(providedType);
    if (!ARTIFACT_TYPES.includes(type)) {
      throw new Error(`Unsupported artifact type "${providedType}". Use one of: skill, agent, subagent, hook.`);
    }
    if (!availableTypes.includes(type)) {
      throw new Error(`No ${type} artifacts are available for the selected target.`);
    }
    return type;
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'type',
      message: 'Select category to install:',
      choices: [
        { name: 'Skills', value: 'skills' },
        { name: 'Agents', value: 'agents' },
        { name: 'Subagents', value: 'subagents' },
        { name: 'Hooks', value: 'hooks' }
      ].filter((choice) => availableTypes.includes(choice.value))
    }
  ]);
  return answer.type;
}

async function chooseTargetPath(defaultPath, providedPath) {
  if (providedPath) return providedPath;
  const answer = await inquirer.prompt([
    {
      type: 'input',
      name: 'targetPath',
      message: 'Target path:',
      default: defaultPath,
      validate: (value) => value?.trim() ? true : 'Enter a target path.'
    }
  ]);
  return answer.targetPath;
}

async function chooseArtifacts(type, artifacts, requestedName) {
  if (requestedName) {
    const resolved = resolveArtifactFromList(type, artifacts, requestedName);
    if (!resolved.artifact) throw new Error(`${type} artifact "${requestedName}" not found.`);
    if (resolved.ambiguous) {
      console.log(chalk.yellow(`> Multiple artifacts named "${requestedName}" found; using ${artifactKey(resolved.artifact, type)}.`));
      console.log(chalk.gray(`> Use one of ${resolved.matches.map((artifact) => artifactKey(artifact, type)).join(' or ')} to be explicit.`));
    }
    return [resolved.artifact];
  }

  const answer = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: `Select ${type} to install:`,
      choices: artifacts.map((artifact) => ({
        name: `${artifactKey(artifact, type)} (v${artifact.version})`,
        value: artifactKey(artifact, type)
      })),
      validate: (selected) => selected.length < 1 ? 'You must choose at least one artifact.' : true
    }
  ]);

  return answer.selected.map((selected) => resolveArtifactFromList(type, artifacts, selected).artifact);
}

function defaultTargetPath(type, artifacts) {
  // Skills get no global default: writing outside a project profile must be a
  // deliberate, explicitly typed path.
  if (type === 'skills') return undefined;
  return artifacts[0]?.runtimeTarget;
}

function destinationForArtifact(type, artifact, targetPath) {
  const expanded = expandHome(targetPath);
  if (type === 'skills') return path.join(expanded, artifact.name);
  return expanded;
}

function getAgentCore(registry) {
  return (registry.managedAgents || []).find((artifact) => artifact.sourceOnly && artifact.name === 'agents-core');
}

const PLACEHOLDER_PATTERN = /\{\{([a-z0-9_]+)\}\}/g;

function substituteVars(content, vars = {}) {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function findUnresolvedPlaceholders(content) {
  return [...new Set([...content.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))];
}

async function composeAgentContent(registry, artifact) {
  const core = getAgentCore(registry);
  if (!core) throw new Error('Missing source-only agents-core artifact.');

  const corePath = path.join(REPO_ROOT, core.path);
  const overlayPath = path.join(REPO_ROOT, artifact.path);
  const coreContent = await fs.readFile(corePath, 'utf8');
  const overlayContent = await fs.readFile(overlayPath, 'utf8');
  const composed = `${coreContent.trimEnd()}\n\n---\n\n${overlayContent.trimEnd()}\n`;
  return substituteVars(composed, artifact.vars);
}

async function confirmOverwrite(destPath, yes) {
  if (!await fs.pathExists(destPath)) return true;
  if (yes) return true;

  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'overwrite',
      message: `${destPath} already exists. Overwrite?`,
      default: false
    }
  ]);
  return answer.overwrite;
}

async function findFileCollisions(sourceDir, destDir) {
  const collisions = [];
  for (const sourceFile of await listFilesRecursive(sourceDir)) {
    const relativeFile = path.relative(sourceDir, sourceFile);
    const destFile = path.join(destDir, relativeFile);
    if (await fs.pathExists(destFile)) collisions.push(destFile);
  }
  return collisions;
}

async function confirmDirectoryMerge(sourcePath, destPath, yes) {
  if (!await fs.pathExists(destPath)) return true;

  const destStat = await fs.stat(destPath);
  if (!destStat.isDirectory()) {
    throw new Error(`${destPath} exists and is not a directory.`);
  }

  const collisions = await findFileCollisions(sourcePath, destPath);
  if (collisions.length === 0) return true;
  if (yes) return true;

  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'overwrite',
      message: `${collisions.length} file(s) already exist under ${destPath}. Overwrite matching file(s)?`,
      default: false
    }
  ]);
  return answer.overwrite;
}

async function copyArtifact(type, artifact, targetPath, { registry, yes = false } = {}) {
  const sourcePath = path.join(REPO_ROOT, artifact.path);
  const destPath = destinationForArtifact(type, artifact, targetPath);
  const sourceStat = await fs.stat(sourcePath);

  const shouldCopy = sourceStat.isDirectory()
    ? await confirmDirectoryMerge(sourcePath, destPath, yes)
    : await confirmOverwrite(destPath, yes);

  if (!shouldCopy) {
    console.log(chalk.yellow(`  Skipped ${artifactKey(artifact, type)}`));
    return { copied: false, destPath };
  }

  await fs.ensureDir(path.dirname(destPath));
  if (type === 'agents') {
    await fs.writeFile(destPath, await composeAgentContent(registry, artifact));
  } else {
    await fs.copy(sourcePath, destPath, { overwrite: true });
  }
  console.log(chalk.green(`  ${artifactKey(artifact, type)} -> ${destPath}`));
  return { copied: true, destPath };
}

async function installArtifacts({
  artifactName,
  providedType,
  providedTarget,
  providedPath,
  yes = false
}) {
  const registry = await readRegistry();
  const target = await chooseTool(registry, providedTarget);
  const availableTypes = getAvailableArtifactTypes(registry, target);
  if (availableTypes.length === 0) throw new Error(`No artifacts are available for target "${target}".`);

  const type = await chooseArtifactType(providedType, availableTypes);
  if (type === 'skills') {
    console.log(chalk.yellow(`Note: skills are project-scoped; prefer "${CLI_NAME} project add" + "${CLI_NAME} sync". Continuing as a low-level copy to an explicit path.`));
  }
  const allArtifacts = getArtifactsByType(registry, type);
  const targetArtifacts = filterArtifactsForTarget(type, allArtifacts, target);
  if (targetArtifacts.length === 0) throw new Error(`No ${type} artifacts match target "${target}".`);

  const targetDefault = defaultTargetPath(type, targetArtifacts);
  const targetPath = await chooseTargetPath(targetDefault, providedPath);
  if (!targetPath) throw new Error(`No target path available for ${type}.`);

  const artifacts = await chooseArtifacts(type, targetArtifacts, artifactName);
  let copied = 0;

  for (const artifact of artifacts) {
    const result = await copyArtifact(type, artifact, targetPath, { registry, yes });
    if (result.copied) copied += 1;
  }

  return { type, copied, total: artifacts.length };
}

// --- Project skill profiles (skill-forge.json / skill-forge.lock.json) ---

function projectManifestPath(projectRoot) {
  return path.join(projectRoot, PROJECT_MANIFEST_NAME);
}

function projectLockPath(projectRoot) {
  return path.join(projectRoot, PROJECT_LOCK_NAME);
}

async function readProjectManifest(projectRoot) {
  const manifestPath = projectManifestPath(projectRoot);
  if (!await fs.pathExists(manifestPath)) {
    throw new Error(`No ${PROJECT_MANIFEST_NAME} in ${projectRoot}. Run "${CLI_NAME} project init" first.`);
  }
  const manifest = await fs.readJson(manifestPath);
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported ${PROJECT_MANIFEST_NAME} schemaVersion ${manifest.schemaVersion}; expected 1.`);
  }
  if (manifest.extends !== undefined && !Array.isArray(manifest.extends)) {
    throw new Error(`${PROJECT_MANIFEST_NAME} "extends" must be an array of profile names.`);
  }
  for (const section of ['dependencies', 'local']) {
    const value = manifest.skills?.[section];
    if (value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`${PROJECT_MANIFEST_NAME} "skills.${section}" must be an object.`);
    }
  }
  for (const tool of Object.keys(manifest.tools || {})) {
    if (!PROJECT_TOOLS.includes(tool)) {
      throw new Error(`${PROJECT_MANIFEST_NAME} "tools" has unknown tool "${tool}". Use: ${PROJECT_TOOLS.join(', ')}.`);
    }
  }
  return manifest;
}

async function writeProjectManifest(projectRoot, manifest) {
  await fs.writeJson(projectManifestPath(projectRoot), manifest, { spaces: 2 });
}

function resolveProjectProfile(registry, manifest) {
  const rangesByName = new Map();
  const addRange = (name, range, origin) => {
    if (!rangesByName.has(name)) rangesByName.set(name, []);
    rangesByName.get(name).push({ range, origin });
  };

  for (const profileName of manifest.extends || []) {
    const profile = (registry.profiles || {})[profileName];
    if (!profile) {
      const known = Object.keys(registry.profiles || {}).join(', ') || 'none';
      throw new Error(`Unknown profile "${profileName}" in extends; registry.json defines: ${known}.`);
    }
    for (const [name, range] of Object.entries(profile)) addRange(name, range, `profile "${profileName}"`);
  }
  for (const [name, range] of Object.entries(manifest.skills?.dependencies || {})) {
    addRange(name, range, PROJECT_MANIFEST_NAME);
  }

  const locals = [];
  for (const [name, relPath] of Object.entries(manifest.skills?.local || {})) {
    if (rangesByName.has(name)) {
      throw new Error(`"${name}" is declared as both a dependency and a local skill; pick one.`);
    }
    locals.push({ name, relPath: assertSafeRelativePath(relPath, `skills.local["${name}"]`) });
  }

  const resolved = [];
  for (const [name, ranges] of [...rangesByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { skill } = resolveSkill(registry, name);
    if (!skill || !skill.installable) {
      throw new Error(`Skill "${name}" is not an installable registry skill. See "${CLI_NAME} list".`);
    }
    for (const { range, origin } of ranges) {
      if (!satisfiesRange(skill.version, range)) {
        throw new Error(`Skill "${name}"@${skill.version} does not satisfy range "${range}" (${origin}). Update the range or the registry.`);
      }
    }
    resolved.push({ name, skill });
  }
  return { resolved, locals };
}

/**
 * The tool-neutral dir serves the tools without native project-skill support
 * (instruction-protocol discovery); a Claude-Code-only profile skips it so
 * skills aren't committed twice for a single reader.
 */
function projectSkillDirs(manifest) {
  const dirs = [];
  const needsNeutralDir = PROJECT_TOOLS.some((tool) => !TOOL_PROJECT_SKILL_DIRS[tool] && manifest.tools?.[tool]);
  if (needsNeutralDir) dirs.push(PROJECT_NEUTRAL_SKILL_DIR);
  for (const [tool, dir] of Object.entries(TOOL_PROJECT_SKILL_DIRS)) {
    if (manifest.tools?.[tool]) dirs.push(dir);
  }
  if (dirs.length === 0) {
    throw new Error(`No tools enabled in ${PROJECT_MANIFEST_NAME}; enable at least one under "tools".`);
  }
  return dirs;
}

function allCandidateSkillDirs() {
  return [PROJECT_NEUTRAL_SKILL_DIR, ...Object.values(TOOL_PROJECT_SKILL_DIRS)];
}

async function getRegistryCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function buildProjectLock(projectRoot, registry, resolution) {
  if (!await fs.pathExists(REGISTRY_LOCK_PATH)) {
    throw new Error(`registry-lock.json is missing in the Skill Forge repo; run "${CLI_NAME} lock" there first.`);
  }
  const lockIntegrity = await hashBytes(await fs.readFile(REGISTRY_LOCK_PATH));

  const skills = {};
  for (const { name, skill } of resolution.resolved) {
    const { integrity } = await hashTree(assertPathWithinInventorySkills(skill.path));
    skills[name] = { version: skill.version, integrity, source: 'registry' };
  }
  for (const { name, relPath } of resolution.locals) {
    const absPath = path.join(projectRoot, relPath);
    if (!await fs.pathExists(absPath)) {
      throw new Error(`skills.local["${name}"] path "${relPath}" does not exist.`);
    }
    const { integrity } = await hashTree(absPath);
    skills[name] = { path: relPath, integrity, source: 'local' };
  }

  return {
    schemaVersion: 1,
    registry: {
      name: registry.name,
      version: registry.version,
      commit: await getRegistryCommit(),
      lockIntegrity
    },
    skills: Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b)))
  };
}

/** registry.commit moves with unrelated registry commits; drift compares content only. */
function comparableProjectLock(lock) {
  if (!lock) return null;
  return JSON.stringify({ ...lock, registry: { ...lock.registry, commit: null } }, null, 2);
}

async function computeProjectState(projectRoot) {
  const registry = await readRegistry();
  const manifest = await readProjectManifest(projectRoot);
  const resolution = resolveProjectProfile(registry, manifest);
  const targetDirs = projectSkillDirs(manifest);
  const expectedLock = await buildProjectLock(projectRoot, registry, resolution);
  const lockPath = projectLockPath(projectRoot);
  const storedLock = await fs.pathExists(lockPath) ? await fs.readJson(lockPath) : null;

  const issues = [];
  if (!storedLock) {
    issues.push(`${PROJECT_LOCK_NAME} is missing; run "${CLI_NAME} sync".`);
  } else if (comparableProjectLock(storedLock) !== comparableProjectLock(expectedLock)) {
    issues.push(`${PROJECT_LOCK_NAME} is stale (manifest, registry, or local skill changed); run "${CLI_NAME} sync".`);
  }

  const vendored = [];
  for (const { name } of resolution.resolved) {
    const expected = expectedLock.skills[name];
    for (const dir of targetDirs) {
      const destPath = path.join(projectRoot, dir, name);
      if (!await fs.pathExists(destPath)) {
        vendored.push({ name, dir, status: 'missing' });
        issues.push(`${path.join(dir, name)} is missing; run "${CLI_NAME} sync".`);
      } else {
        const { integrity } = await hashTree(destPath);
        const status = integrity === expected.integrity ? 'clean' : 'differs';
        vendored.push({ name, dir, status });
        if (status === 'differs') issues.push(`${path.join(dir, name)} differs from the resolved skill; run "${CLI_NAME} sync".`);
      }
    }
  }

  const resolvedNames = new Set(resolution.resolved.map(({ name }) => name));
  const staleNames = Object.entries(storedLock?.skills || {})
    .filter(([name, entry]) => entry.source === 'registry' && !resolvedNames.has(name))
    .map(([name]) => name);
  for (const name of staleNames) {
    for (const dir of targetDirs) {
      if (await fs.pathExists(path.join(projectRoot, dir, name))) {
        issues.push(`${path.join(dir, name)} is no longer in the profile; run "${CLI_NAME} sync" to prune it.`);
      }
    }
  }

  // Copies left in dirs the current tool set no longer targets (e.g. after
  // narrowing tools to claude-code only). Declared local paths are exempt.
  const inactiveDirs = allCandidateSkillDirs().filter((dir) => !targetDirs.includes(dir));
  const localPaths = new Set(resolution.locals.map(({ relPath }) => path.normalize(relPath)));
  const registryNames = new Set([
    ...resolvedNames,
    ...Object.entries(storedLock?.skills || {})
      .filter(([, entry]) => entry.source === 'registry')
      .map(([name]) => name)
  ]);
  const orphaned = [];
  for (const name of registryNames) {
    for (const dir of inactiveDirs) {
      const relPath = path.join(dir, name);
      if (localPaths.has(path.normalize(relPath))) continue;
      if (await fs.pathExists(path.join(projectRoot, relPath))) {
        orphaned.push(relPath);
        issues.push(`${relPath} is not a sync target for the enabled tools; run "${CLI_NAME} sync" to prune it.`);
      }
    }
  }

  return { registry, manifest, resolution, targetDirs, expectedLock, storedLock, staleNames, orphaned, vendored, issues };
}

async function syncProject(projectRoot) {
  const state = await computeProjectState(projectRoot);
  const { resolution, targetDirs, expectedLock, storedLock } = state;

  for (const { name, skill } of resolution.resolved) {
    const sourcePath = assertPathWithinInventorySkills(skill.path);
    for (const dir of targetDirs) {
      const destPath = path.join(projectRoot, dir, name);
      if (await fs.pathExists(destPath)) {
        const owned = storedLock?.skills?.[name]?.source === 'registry';
        const { integrity } = await hashTree(destPath);
        if (!owned && integrity !== expectedLock.skills[name].integrity) {
          throw new Error(`${path.join(dir, name)} exists but is not managed by Skill Forge. Declare it in skills.local, rename it, or remove it.`);
        }
        await fs.remove(destPath);
      }
      await fs.ensureDir(path.dirname(destPath));
      await fs.copy(sourcePath, destPath);
    }
    console.log(chalk.green(`  ${name}@${skill.version} -> ${targetDirs.join(', ')}`));
  }

  for (const name of state.staleNames) {
    for (const dir of targetDirs) {
      const destPath = path.join(projectRoot, dir, name);
      if (await fs.pathExists(destPath)) {
        await fs.remove(destPath);
        console.log(chalk.yellow(`  pruned ${path.join(dir, name)}`));
      }
    }
  }

  for (const relPath of state.orphaned) {
    await fs.remove(path.join(projectRoot, relPath));
    console.log(chalk.yellow(`  pruned ${relPath} (not a target for the enabled tools)`));
  }

  // A narrowed tool set shouldn't leave husk directories behind: drop inactive
  // candidate dirs (and their parents) once they are empty.
  for (const dir of allCandidateSkillDirs()) {
    if (targetDirs.includes(dir)) continue;
    let current = path.join(projectRoot, dir);
    while (current !== projectRoot) {
      const entries = await fs.readdir(current).catch(() => null);
      if (!entries || entries.length > 0) break;
      await fs.remove(current);
      current = path.dirname(current);
    }
  }

  await fs.writeJson(projectLockPath(projectRoot), expectedLock, { spaces: 2 });
  console.log(chalk.green(`Wrote ${PROJECT_LOCK_NAME} (${resolution.resolved.length} registry, ${resolution.locals.length} local skill(s)).`));
}

program
  .command('list')
  .description('List available skills')
  .option('--all', 'Include all tracked skill inventory')
  .action(async (options) => {
    try {
      const registry = await readRegistry();
      const skills = getSkillEntries(registry, {
        installableOnly: !options.all
      });

      console.log(chalk.blue.bold(options.all ? '\nAll Skills:' : '\nAvailable Skills:'));
      if (skills.length === 0) {
        console.log(chalk.yellow('  No skills found.'));
      } else {
        for (const skill of skills) {
          const installable = skill.installable ? 'installable' : 'tracked';
          console.log(`- ${skillKey(skill)} (${installable}, v${skill.version})`);
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red('Error listing skills:'), error.message);
      process.exitCode = 1;
    }
  });

const skillCommand = program
  .command('skill')
  .description('Read, write, and delete skill inventory artifacts (agent-facing; auto-runs lock + validate on mutation)');

skillCommand
  .command('list')
  .description('List skills in the registry')
  .option('--all', 'Include tracked (non-installable) skills')
  .option('--json', 'Output structured JSON')
  .action(async (options) => {
    try {
      const registry = await readRegistry();
      const skills = getSkillEntries(registry, { installableOnly: !options.all });

      if (options.json) {
        const summaries = await Promise.all(skills.map(async (skill) => ({
          ...toSkillSummary(skill),
          description: await readSkillDescription(skill)
        })));
        console.log(JSON.stringify(summaries, null, 2));
        return;
      }

      console.log(chalk.blue.bold(options.all ? '\nAll Skills:' : '\nAvailable Skills:'));
      if (skills.length === 0) {
        console.log(chalk.yellow('  No skills found.'));
      } else {
        for (const skill of skills) {
          const installable = skill.installable ? 'installable' : 'tracked';
          console.log(`- ${skillKey(skill)} (${installable}, v${skill.version})`);
        }
      }
      console.log();
    } catch (error) {
      printSkillError(options, `Error listing skills: ${error.message}`);
    }
  });

skillCommand
  .command('read <name>')
  .description("Print a skill's SKILL.md and companion file contents plus registry metadata")
  .option('--json', 'Output structured JSON')
  .action(async (name, options) => {
    try {
      const registry = await readRegistry();
      const { skill, ambiguous, matches } = resolveSkill(registry, name);
      if (!skill) throw new Error(`Skill "${name}" not found.`);
      if (ambiguous) throw new Error(`Multiple skills named "${name}" found: ${matches.map(skillKey).join(', ')}. Use a scoped name.`);

      const skillDir = assertPathWithinInventorySkills(skill.path);
      const body = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      const companionPaths = (await listFilesRecursive(skillDir))
        .map((filePath) => path.relative(skillDir, filePath))
        .filter((relPath) => !isSkillMdRelPath(relPath));
      const companions = {};
      for (const relPath of companionPaths) {
        companions[relPath] = await fs.readFile(path.join(skillDir, relPath), 'utf8');
      }

      if (options.json) {
        console.log(JSON.stringify({ ...toSkillSummary(skill), body, companions }, null, 2));
        return;
      }

      console.log(chalk.blue.bold(`\n${skillKey(skill)} (v${skill.version})`));
      console.log(chalk.gray(`tags: ${(skill.tags || []).join(', ') || '—'} | installable: ${skill.installable} | path: ${skill.path}`));
      if (companionPaths.length > 0) console.log(chalk.gray(`companions: ${companionPaths.join(', ')}`));
      console.log();
      console.log(chalk.blue.bold('--- SKILL.md ---'));
      console.log(body);
      for (const relPath of companionPaths) {
        console.log(chalk.blue.bold(`\n--- ${relPath} ---`));
        console.log(companions[relPath]);
      }
    } catch (error) {
      printSkillError(options, `Error reading skill: ${error.message}`);
    }
  });

skillCommand
  .command('write <name>')
  .description("Create or update a skill's SKILL.md and companion files, optionally remove companion files, and sync the registry (auto-runs lock + validate)")
  .option('--set-version <semver>', 'Registry version, e.g. 0.2.0 (required when creating a new skill; named --set-version to avoid colliding with the global -V/--version flag)')
  .option('--tags <list>', 'Comma-separated tags; replaces existing tags when provided')
  .option('--installable <bool>', '"true" or "false"; defaults to "true" for new skills, unchanged on update')
  .option('--file <assignment>', 'Additional file to write, formatted <relative-path>=<local-source-path>; repeatable. Use "SKILL.md=<path>" instead of stdin, or any other relative path for a companion file', (value, previous) => [...previous, value], [])
  .option('--remove-file <relativePath>', 'Companion file to delete from the skill directory; repeatable. Cannot remove "SKILL.md" — use "skill delete" to remove the whole skill', (value, previous) => [...previous, value], [])
  .option('--skip-skill-md', 'Leave SKILL.md untouched (only valid when updating an existing skill); use for companion/metadata/removal-only changes')
  .option('--json', 'Output structured JSON')
  .action(async (name, options) => {
    try {
      if (!SKILL_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid skill name "${name}". Use lowercase letters, digits, and hyphens (e.g. "my-skill").`);
      }
      if (options.setVersion && !SEMVER_PATTERN.test(options.setVersion)) {
        throw new Error(`Invalid --set-version "${options.setVersion}". Use semver, e.g. "0.1.0".`);
      }
      if (options.installable !== undefined && !['true', 'false'].includes(options.installable)) {
        throw new Error('--installable must be "true" or "false".');
      }

      const fileAssignments = options.file.map(parseFileAssignment);
      assertNoDuplicateRelPaths(fileAssignments.map((assignment) => assignment.relPath), '--file');
      const skillMdAssignment = fileAssignments.find((assignment) => assignment.relPath === 'SKILL.md');
      const companionAssignments = fileAssignments.filter((assignment) => assignment.relPath !== 'SKILL.md');
      if (options.skipSkillMd && skillMdAssignment) {
        throw new Error('--skip-skill-md and --file SKILL.md=<path> are mutually exclusive.');
      }

      const removeFiles = options.removeFile.map((relPath) => {
        const safe = assertSafeRelativePath(relPath, '--remove-file path');
        if (isSkillMdRelPath(safe)) {
          throw new Error('Cannot remove "SKILL.md" via --remove-file; use "skill delete" to remove the whole skill.');
        }
        return safe;
      });
      assertNoDuplicateRelPaths(removeFiles, '--remove-file');
      const overlap = removeFiles.find((relPath) => fileAssignments.some((assignment) => assignment.relPath === relPath));
      if (overlap) throw new Error(`"--file" and "--remove-file" both target "${overlap}"; that's ambiguous.`);

      const registry = await readRegistry();
      const existingIndex = registry.skills.findIndex((skill) => skill.scope === 'custom' && skill.name === name);
      const isNew = existingIndex === -1;
      if (isNew && !options.setVersion) throw new Error('--set-version is required when creating a new skill.');
      if (isNew && options.skipSkillMd) throw new Error('--skip-skill-md cannot be used when creating a new skill; SKILL.md is required.');

      const skillDir = path.join(REPO_ROOT, 'inventory/skills', name);

      // Preflight: resolve and validate everything in memory before touching the filesystem,
      // so a bad input (missing local file, bad frontmatter) never leaves a partial write behind.
      let body = null;
      if (!options.skipSkillMd) {
        if (!skillMdAssignment) assertSkillMdStdinAvailable(Boolean(process.stdin.isTTY));
        if (skillMdAssignment) await assertLocalSourceFile('SKILL.md', skillMdAssignment.localPath);
        body = skillMdAssignment ? await fs.readFile(skillMdAssignment.localPath, 'utf8') : await readStdin();
        if (!body.trim()) {
          throw new Error('No SKILL.md content received (via stdin or --file SKILL.md=<path>). Pass --skip-skill-md to leave SKILL.md untouched on an update.');
        }

        const frontmatter = parseFrontmatter(body);
        if (!frontmatter) throw new Error('SKILL.md content is missing YAML frontmatter (--- name/description ---).');
        if (!frontmatter.name) throw new Error('Frontmatter is missing required field "name".');
        if (!frontmatter.description) throw new Error('Frontmatter is missing required field "description".');
        if (frontmatter.name !== name) throw new Error(`Frontmatter name "${frontmatter.name}" does not match "${name}".`);
        if (frontmatter.version) throw new Error('Frontmatter must not include "version"; pass --set-version instead.');
      }

      for (const { relPath, localPath } of companionAssignments) {
        await assertLocalSourceFile(relPath, localPath);
      }

      const removalPlans = [];
      for (const relPath of removeFiles) {
        const destPath = path.join(skillDir, relPath);
        const stat = await fs.stat(destPath).catch(() => null);
        if (stat && stat.isDirectory()) {
          throw new Error(`--remove-file "${relPath}" is a directory; refusing to remove it recursively. Remove its files individually.`);
        }
        removalPlans.push({ relPath, destPath, exists: Boolean(stat) });
      }

      // Mutate: preflight passed. Failures here are genuine I/O/registry issues.
      // New-skill dirs are rolled back only if the registry entry was never written.
      // Any durable change sets partial: true on JSON errors so agents can re-issue write.
      const skillDirExistedBefore = await fs.pathExists(skillDir);
      let mutated = false;
      let registryWritten = false;
      const removedFiles = [];
      const removeNotices = [];

      try {
        await fs.ensureDir(skillDir);
        if (!options.skipSkillMd) {
          await fs.writeFile(path.join(skillDir, 'SKILL.md'), body.endsWith('\n') ? body : `${body}\n`);
          mutated = true;
        }
        for (const { relPath, localPath } of companionAssignments) {
          const destPath = path.join(skillDir, relPath);
          await fs.ensureDir(path.dirname(destPath));
          await fs.copy(localPath, destPath, { overwrite: true });
          mutated = true;
        }

        for (const { relPath, destPath, exists } of removalPlans) {
          if (exists) {
            await fs.remove(destPath);
            await pruneEmptyParents(path.dirname(destPath), skillDir);
            removedFiles.push(relPath);
            mutated = true;
          } else {
            removeNotices.push(`--remove-file "${relPath}" not found; nothing removed.`);
          }
        }

        const entry = isNew
          ? {
              type: 'skill',
              name,
              version: options.setVersion,
              scope: 'custom',
              path: `inventory/skills/${name}`,
              installable: options.installable === undefined ? true : options.installable === 'true',
              runtimeTarget: `~/.codex/skills/${name}`,
              tags: options.tags ? splitTags(options.tags) : []
            }
          : { ...registry.skills[existingIndex] };

        if (!isNew) {
          if (options.setVersion) entry.version = options.setVersion;
          if (options.tags) entry.tags = splitTags(options.tags);
          if (options.installable !== undefined) entry.installable = options.installable === 'true';
        }

        if (isNew) registry.skills.push(entry);
        else registry.skills[existingIndex] = entry;

        await writeRegistry(registry);
        registryWritten = true;
        mutated = true;
        await writeLock({ silent: options.json });
        mutated = true;

        const { errors, warnings: validationWarnings } = await validateRegistry();
        const warnings = [...removeNotices, ...validationWarnings];
        if (!options.json) for (const warning of warnings) console.log(chalk.yellow(`Warning: ${warning}`));

        if (errors.length > 0) {
          const message = `Skill "${name}" was written but registry validation failed; fix and re-run "${CLI_NAME} validate".`;
          if (options.json) {
            console.log(JSON.stringify({ error: message, errors, warnings, partial: true }, null, 2));
          } else {
            for (const error of errors) console.error(chalk.red(`Error: ${error}`));
            console.error(chalk.red(message));
          }
          process.exitCode = 1;
          return;
        }

        if (options.json) {
          console.log(JSON.stringify({ action: isNew ? 'created' : 'updated', skill: toSkillSummary(entry), removedFiles, warnings }, null, 2));
          return;
        }
        console.log(chalk.green(`${isNew ? 'Created' : 'Updated'} ${skillKey(entry)} (v${entry.version}).`));
        if (removedFiles.length > 0) console.log(chalk.gray(`Removed: ${removedFiles.join(', ')}`));
      } catch (mutationError) {
        if (isNew && !skillDirExistedBefore && !registryWritten) {
          await fs.remove(skillDir).catch(() => {});
          mutated = false;
        }
        if (mutated) mutationError.partial = true;
        throw mutationError;
      }
    } catch (error) {
      printSkillError(
        options,
        `Error writing skill: ${error.message}`,
        error.partial ? { partial: true } : {}
      );
    }
  });

skillCommand
  .command('delete <name>')
  .description('Delete a skill from inventory and the registry (auto-runs lock + validate)')
  .option('-y, --yes', 'Confirm deletion (required — there is no interactive prompt)')
  .option('--json', 'Output structured JSON')
  .action(async (name, options) => {
    try {
      if (!options.yes) throw new Error('Refusing to delete without --yes.');

      const registry = await readRegistry();
      const { skill, ambiguous, matches } = resolveSkill(registry, name);
      if (!skill) throw new Error(`Skill "${name}" not found.`);
      if (ambiguous) throw new Error(`Multiple skills named "${name}" found: ${matches.map(skillKey).join(', ')}. Use a scoped name.`);

      const resolvedSkillPath = assertPathWithinInventorySkills(skill.path);
      registry.skills = registry.skills.filter((entry) => entry !== skill);
      await fs.remove(resolvedSkillPath);
      await writeRegistry(registry);
      await writeLock({ silent: options.json });
      const { errors, warnings } = await validateRegistry();
      if (!options.json) for (const warning of warnings) console.log(chalk.yellow(`Warning: ${warning}`));

      if (errors.length > 0) {
        const message = `Skill "${name}" was deleted but registry validation failed; fix and re-run "${CLI_NAME} validate".`;
        if (options.json) {
          console.log(JSON.stringify({ error: message, errors, warnings, partial: true }, null, 2));
        } else {
          for (const error of errors) console.error(chalk.red(`Error: ${error}`));
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ action: 'deleted', name, warnings }, null, 2));
        return;
      }
      console.log(chalk.green(`Deleted ${skillKey(skill)}.`));
    } catch (error) {
      printSkillError(options, `Error deleting skill: ${error.message}`);
    }
  });

/**
 * Update a skill's registry version only (no inventory file changes).
 * Shared by set-version and bump.
 */
async function applySkillVersion(name, nextVersion, options, { action, previousVersion }) {
  parseSemver(nextVersion); // validate shape
  const registry = await readRegistry();
  const { skill, ambiguous, matches } = resolveSkill(registry, name);
  if (!skill) throw new Error(`Skill "${name}" not found.`);
  if (ambiguous) throw new Error(`Multiple skills named "${name}" found: ${matches.map(skillKey).join(', ')}. Use a scoped name.`);

  const from = previousVersion ?? skill.version;
  if (from === nextVersion) {
    if (options.json) {
      console.log(JSON.stringify({
        action: 'unchanged',
        skill: toSkillSummary(skill),
        previousVersion: from,
        version: nextVersion,
        warnings: []
      }, null, 2));
      return;
    }
    console.log(chalk.gray(`${skillKey(skill)} already at v${nextVersion}; nothing to do.`));
    return;
  }

  skill.version = nextVersion;
  await writeRegistry(registry);
  await writeLock({ silent: options.json });
  const { errors, warnings } = await validateRegistry();
  if (!options.json) for (const warning of warnings) console.log(chalk.yellow(`Warning: ${warning}`));

  if (errors.length > 0) {
    // Version is already written + locked; partial signals durable mutation before validate failed.
    const message = `Skill "${name}" version was set to ${nextVersion} but registry validation failed; fix and re-run "${CLI_NAME} validate".`;
    if (options.json) {
      console.log(JSON.stringify({
        error: message,
        errors,
        warnings,
        previousVersion: from,
        version: nextVersion,
        partial: true
      }, null, 2));
    } else {
      for (const error of errors) console.error(chalk.red(`Error: ${error}`));
      console.error(chalk.red(message));
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify({
      action,
      skill: toSkillSummary(skill),
      previousVersion: from,
      version: nextVersion,
      warnings
    }, null, 2));
    return;
  }
  console.log(chalk.green(`${skillKey(skill)} ${from} → ${nextVersion}.`));
}

skillCommand
  .command('set-version <name> <semver>')
  .description('Set a skill\'s registry version (auto-runs lock + validate); does not modify SKILL.md')
  .option('--json', 'Output structured JSON')
  .action(async (name, semver, options) => {
    try {
      await applySkillVersion(name, semver, options, { action: 'set-version' });
    } catch (error) {
      printSkillError(options, `Error setting skill version: ${error.message}`);
    }
  });

skillCommand
  .command('bump <name>')
  .description('Bump a skill\'s registry version by one major/minor/patch step (default: --patch)')
  .option('--patch', 'Increment patch (default)')
  .option('--minor', 'Increment minor and reset patch to 0')
  .option('--major', 'Increment major and reset minor and patch to 0')
  .option('--json', 'Output structured JSON')
  .action(async (name, options) => {
    try {
      const levels = [
        options.major && 'major',
        options.minor && 'minor',
        options.patch && 'patch'
      ].filter(Boolean);
      if (levels.length > 1) throw new Error('Specify only one of --major, --minor, or --patch.');
      const level = levels[0] || 'patch';

      const registry = await readRegistry();
      const { skill, ambiguous, matches } = resolveSkill(registry, name);
      if (!skill) throw new Error(`Skill "${name}" not found.`);
      if (ambiguous) throw new Error(`Multiple skills named "${name}" found: ${matches.map(skillKey).join(', ')}. Use a scoped name.`);

      const previousVersion = skill.version;
      const nextVersion = bumpSemver(previousVersion, level);
      await applySkillVersion(name, nextVersion, options, { action: 'bump', previousVersion });
    } catch (error) {
      printSkillError(options, `Error bumping skill version: ${error.message}`);
    }
  });

// The $HOME profile is the same mechanism as a project profile, rooted at the
// home directory; "skf home <verb>" is the ergonomic spelling for it.
const HOME_SEED_SKILLS = ['skill-forge-project'];

const projectCommand = program
  .command('project')
  .description(`Manage this repository's Skill Forge profile (${PROJECT_MANIFEST_NAME})`);

const homeCommand = program
  .command('home')
  .description(`Manage the machine-wide $HOME profile (same mechanism as "project", rooted at your home directory)`);

async function runProjectInit(projectRoot, options, { namespace, seedSkills = [] }) {
  if (await fs.pathExists(projectManifestPath(projectRoot))) {
    throw new Error(`${PROJECT_MANIFEST_NAME} already exists in ${projectRoot}.`);
  }

  let enabledTools;
  if (options.tools) {
    enabledTools = splitTags(options.tools);
    const unknown = enabledTools.filter((tool) => !PROJECT_TOOLS.includes(tool));
    if (unknown.length > 0) throw new Error(`Unknown tool(s): ${unknown.join(', ')}. Use: ${PROJECT_TOOLS.join(', ')}.`);
  } else {
    enabledTools = [...PROJECT_TOOLS];
  }

  const dependencies = {};
  if (seedSkills.length > 0) {
    const registry = await readRegistry();
    for (const name of seedSkills) {
      const { skill } = resolveSkill(registry, name);
      if (!skill || !skill.installable) {
        throw new Error(`Seed skill "${name}" is not in the registry; the Skill Forge install looks broken.`);
      }
      dependencies[skill.name] = `^${skill.version}`;
    }
  }

  const manifest = {
    schemaVersion: 1,
    extends: [],
    skills: { dependencies },
    tools: Object.fromEntries(PROJECT_TOOLS.map((tool) => [tool, enabledTools.includes(tool)]))
  };
  await writeProjectManifest(projectRoot, manifest);
  console.log(chalk.green(`Wrote ${path.join(projectRoot, PROJECT_MANIFEST_NAME)}.`));
  if (seedSkills.length > 0) {
    console.log(chalk.gray(`Seeded: ${Object.entries(dependencies).map(([name, range]) => `${name} ${range}`).join(', ')}.`));
    console.log(chalk.gray(`Next: "${CLI_NAME} ${namespace} sync"; "${CLI_NAME} ${namespace} add <skills...>" for more.`));
  } else {
    console.log(chalk.gray(`Next: "${CLI_NAME} ${namespace} add <skills...>" then "${CLI_NAME} ${namespace === 'project' ? 'sync' : `${namespace} sync`}".`));
  }
}

projectCommand
  .command('init')
  .description(`Create ${PROJECT_MANIFEST_NAME} in the current directory (all tools enabled unless narrowed with --tools)`)
  .option('--tools <list>', `Comma-separated tools to enable: ${PROJECT_TOOLS.join(', ')} (default: all)`)
  .action(async (options) => {
    try {
      await runProjectInit(process.cwd(), options, { namespace: 'project' });
    } catch (error) {
      console.error(chalk.red('Error initializing project:'), error.message);
      process.exitCode = 1;
    }
  });

homeCommand
  .command('init')
  .description(`Create the $HOME profile, seeded with ${HOME_SEED_SKILLS.join(', ')} only; baseline/process skills belong in each repo's own profile`)
  .option('--tools <list>', `Comma-separated tools to enable: ${PROJECT_TOOLS.join(', ')} (default: all)`)
  .action(async (options) => {
    try {
      await runProjectInit(os.homedir(), options, { namespace: 'home', seedSkills: HOME_SEED_SKILLS });
    } catch (error) {
      console.error(chalk.red('Error initializing home profile:'), error.message);
      process.exitCode = 1;
    }
  });

const PROMPT_ESCAPED = Symbol('prompt-escaped');

/**
 * Run one inquirer prompt, resolving to PROMPT_ESCAPED when the user presses
 * Esc (the go-back convention in agent tool CLIs). Piggybacks on the keypress
 * events inquirer already enables on stdin while a prompt is active.
 */
async function promptWithEscape(question) {
  const promptPromise = inquirer.prompt([question]);
  let onKeypress;
  const escaped = new Promise((resolve) => {
    onKeypress = (_char, key) => {
      if (key?.name === 'escape') resolve(PROMPT_ESCAPED);
    };
    process.stdin.on('keypress', onKeypress);
  });

  try {
    const result = await Promise.race([promptPromise, escaped]);
    if (result === PROMPT_ESCAPED) {
      promptPromise.ui.close();
      process.stdout.write('\n');
      return PROMPT_ESCAPED;
    }
    return result;
  } finally {
    process.stdin.removeListener('keypress', onKeypress);
  }
}

/** Interactive search/select; resolves to null when the user cancels with Esc. */
async function promptForRegistrySkills(registry) {
  const entries = [];
  for (const skill of getSkillEntries(registry, { installableOnly: true })) {
    entries.push({ skill, description: await readSkillDescription(skill) });
  }

  for (;;) {
    const queryAnswer = await promptWithEscape({
      type: 'input',
      name: 'query',
      message: 'Search skills (name/tag/description; empty lists all, esc cancels):'
    });
    if (queryAnswer === PROMPT_ESCAPED) return null;

    const needle = queryAnswer.query.trim().toLowerCase();
    const matches = needle
      ? entries.filter(({ skill, description }) =>
          [skill.name, description, ...(skill.tags || [])].join(' ').toLowerCase().includes(needle))
      : entries;
    if (matches.length === 0) {
      console.log(chalk.yellow(`No skills match "${queryAnswer.query}".`));
      continue;
    }

    const selectAnswer = await promptWithEscape({
      type: 'checkbox',
      name: 'selected',
      message: `Select skills to add (${matches.length} match${matches.length === 1 ? '' : 'es'}; esc goes back to search):`,
      pageSize: 15,
      choices: matches.map(({ skill, description }) => ({
        name: `${skill.name}@${skill.version} — ${description.length > 80 ? `${description.slice(0, 80)}…` : description}`,
        value: skill.name,
        short: skill.name
      }))
    });
    if (selectAnswer === PROMPT_ESCAPED || selectAnswer.selected.length === 0) continue;
    return selectAnswer.selected;
  }
}

async function runProjectAdd(projectRoot, skillNames, { syncHint }) {
  const registry = await readRegistry();
  const manifest = await readProjectManifest(projectRoot);

  let names = skillNames;
  if (names.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error('Provide skill names, e.g. "project add frontend-engineering"; interactive search needs a terminal.');
    }
    names = await promptForRegistrySkills(registry);
    if (names === null) {
      console.log(chalk.gray('Cancelled; nothing added.'));
      return;
    }
  }

  manifest.skills = manifest.skills || {};
  manifest.skills.dependencies = manifest.skills.dependencies || {};

  for (const name of names) {
    const { skill } = resolveSkill(registry, name);
    if (!skill || !skill.installable) {
      throw new Error(`Skill "${name}" is not an installable registry skill. See "${CLI_NAME} list".`);
    }
    if (manifest.skills.local?.[skill.name]) {
      throw new Error(`"${skill.name}" is already declared in skills.local; a name cannot be both.`);
    }
    const range = `^${skill.version}`;
    manifest.skills.dependencies[skill.name] = range;
    const tags = (skill.tags || []).join(', ') || '—';
    console.log(chalk.green(`+ ${skill.name} ${range}`) + chalk.gray(` (tags: ${tags})`));
  }

  await writeProjectManifest(projectRoot, manifest);
  console.log(chalk.gray(`Run "${syncHint}" to vendor and lock.`));
}

projectCommand
  .command('add [skills...]')
  .description(`Add registry skills as project dependencies in ${PROJECT_MANIFEST_NAME}; with no names, search interactively`)
  .action(async (skillNames) => {
    try {
      await runProjectAdd(process.cwd(), skillNames, { syncHint: `${CLI_NAME} sync` });
    } catch (error) {
      console.error(chalk.red('Error adding project skill:'), error.message);
      process.exitCode = 1;
    }
  });

homeCommand
  .command('add [skills...]')
  .description('Add registry skills to the $HOME profile; with no names, search interactively')
  .action(async (skillNames) => {
    try {
      await runProjectAdd(os.homedir(), skillNames, { syncHint: `${CLI_NAME} home sync` });
    } catch (error) {
      console.error(chalk.red('Error adding home profile skill:'), error.message);
      process.exitCode = 1;
    }
  });

function buildProjectStatusJson(state) {
  const enabledTools = PROJECT_TOOLS.filter((tool) => state.manifest.tools?.[tool]);
  const skills = [];
  for (const { name, skill } of state.resolution.resolved) {
    const states = state.vendored.filter((entry) => entry.name === name);
    const worst = states.find((entry) => entry.status !== 'clean');
    skills.push({ name, version: skill.version, source: 'registry', state: worst ? worst.status : 'clean' });
  }
  for (const { name, relPath } of state.resolution.locals) {
    skills.push({ name, path: relPath, source: 'local', state: 'clean' });
  }
  return {
    tools: enabledTools,
    targets: state.targetDirs,
    extends: state.manifest.extends || [],
    skills,
    staleNames: state.staleNames,
    issues: state.issues
  };
}

async function runProjectStatus(projectRoot, options) {
  const state = await computeProjectState(projectRoot);
  const enabledTools = PROJECT_TOOLS.filter((tool) => state.manifest.tools?.[tool]);

  if (options.json) {
    console.log(JSON.stringify(buildProjectStatusJson(state), null, 2));
    return;
  }

  console.log(chalk.blue.bold('\nProject profile'));
  console.log(chalk.gray(`tools: ${enabledTools.join(', ') || '—'} | targets: ${state.targetDirs.join(', ')} | registry: ${state.registry.name} v${state.registry.version}`));
  if ((state.manifest.extends || []).length > 0) console.log(chalk.gray(`extends: ${state.manifest.extends.join(', ')}`));

  for (const { name, skill } of state.resolution.resolved) {
    const states = state.vendored.filter((entry) => entry.name === name);
    const worst = states.find((entry) => entry.status !== 'clean');
    const marker = worst ? chalk.yellow(worst.status) : chalk.green('clean');
    console.log(`- ${name}@${skill.version} (registry) ${marker}`);
  }
  for (const { name, relPath } of state.resolution.locals) {
    console.log(`- ${name} (local: ${relPath})`);
  }
  for (const name of state.staleNames) {
    console.log(chalk.yellow(`- ${name} (no longer in profile; sync will prune)`));
  }
  if (state.resolution.resolved.length === 0 && state.resolution.locals.length === 0) {
    console.log(chalk.yellow(`No skills declared. Use "${CLI_NAME} project add <skills...>".`));
  }

  console.log();
  if (state.issues.length === 0) {
    console.log(chalk.green('In sync.'));
  } else {
    for (const issue of state.issues) console.log(chalk.yellow(`! ${issue}`));
  }
}

projectCommand
  .command('status')
  .description('Show the active project profile: skills, sources, and sync state')
  .option('--json', 'Output structured JSON')
  .action(async (options) => {
    try {
      await runProjectStatus(process.cwd(), options);
    } catch (error) {
      printSkillError(options, `Error reading project status: ${error.message}`);
    }
  });

homeCommand
  .command('status')
  .description('Show the $HOME profile: skills, sources, and sync state')
  .option('--json', 'Output structured JSON')
  .action(async (options) => {
    try {
      await runProjectStatus(os.homedir(), options);
    } catch (error) {
      printSkillError(options, `Error reading home profile status: ${error.message}`);
    }
  });

async function runSyncCommand(projectRoot, options) {
  if (options.check) {
    const state = await computeProjectState(projectRoot);
    if (state.issues.length === 0) {
      console.log(chalk.green('Project profile is in sync.'));
      return;
    }
    for (const issue of state.issues) console.error(chalk.yellow(`! ${issue}`));
    process.exitCode = 1;
    return;
  }
  await syncProject(projectRoot);
}

program
  .command('sync')
  .description(`Make this repository match its declared profile: vendor skills and write ${PROJECT_LOCK_NAME}`)
  .option('--check', 'Read-only; exit non-zero when manifest, lockfile, or vendored copies are stale')
  .action(async (options) => {
    try {
      await runSyncCommand(process.cwd(), options);
    } catch (error) {
      console.error(chalk.red('Error syncing project:'), error.message);
      process.exitCode = 1;
    }
  });

homeCommand
  .command('sync')
  .description('Make the $HOME profile match its manifest: vendor skills to ~/.agents/skills (+ tool user dirs)')
  .option('--check', 'Read-only; exit non-zero when manifest, lockfile, or vendored copies are stale')
  .action(async (options) => {
    try {
      await runSyncCommand(os.homedir(), options);
    } catch (error) {
      console.error(chalk.red('Error syncing home profile:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('add [skillName]', { hidden: true })
  .description('Deprecated: install skill(s) to a global tool directory')
  .option('-d, --dir <path>', 'Destination directory for skills')
  .option('--target <tool>', 'Target tool for default path selection')
  .option('-y, --yes', 'Overwrite existing target paths without prompting')
  .action(async (skillName, options) => {
    try {
      console.log(chalk.yellow('Warning: "add" is deprecated. Use "project add" + "sync" in a repository, or a $HOME profile for skills wanted everywhere.'));
      const result = await installArtifacts({
        artifactName: skillName,
        providedType: 'skills',
        providedTarget: options.target || 'codex',
        providedPath: options.dir,
        yes: options.yes
      });
      console.log(chalk.blue(`\nDone. Installed ${result.copied}/${result.total} skill artifact(s).`));
    } catch (error) {
      console.error(chalk.red('Error installing skill:'), error.message);
      process.exitCode = 1;
    }
  });

function registerInstallCommand() {
  program
    .command('install [artifactName]')
    .description('Install skills, agents, or subagents with target selection and overwrite confirmation')
    .option('-t, --type <type>', 'Artifact type: skill, agent, or subagent')
    .option('--target <tool>', 'Target tool: codex, copilot-cli, claude-code, or grok')
    .option('-p, --path <path>', 'Custom target path')
    .option('-y, --yes', 'Overwrite existing target paths without prompting')
    .action(async (artifactName, options) => {
      try {
        const result = await installArtifacts({
          artifactName,
          providedType: options.type,
          providedTarget: options.target,
          providedPath: options.path,
          yes: options.yes
        });
        console.log(chalk.blue(`\nDone. Installed ${result.copied}/${result.total} ${result.type} artifact(s).`));
      } catch (error) {
        console.error(chalk.red('Error running install:'), error.message);
        process.exitCode = 1;
      }
    });
}

registerInstallCommand();

function registerArtifactNamespace(noun, type, listArtifacts) {
  const namespace = program
    .command(noun)
    .description(`Manage global ${type} installs (these stay global; skills are project-scoped via "project"/"sync")`);

  namespace
    .command('install [artifactName]')
    .description(`Install managed ${type} for a target tool`)
    .option('--target <tool>', 'Target tool: codex, copilot-cli, claude-code, or grok')
    .option('-p, --path <path>', 'Custom target path')
    .option('-y, --yes', 'Overwrite existing target paths without prompting')
    .action(async (artifactName, options) => {
      try {
        const result = await installArtifacts({
          artifactName,
          providedType: type,
          providedTarget: options.target,
          providedPath: options.path,
          yes: options.yes
        });
        console.log(chalk.blue(`\nDone. Installed ${result.copied}/${result.total} ${result.type} artifact(s).`));
      } catch (error) {
        console.error(chalk.red(`Error installing ${type}:`), error.message);
        process.exitCode = 1;
      }
    });

  namespace
    .command('diff')
    .description(`Compare managed ${type} against their runtime targets without writing`)
    .action(async () => {
      try {
        const registry = await readRegistry();
        for (const artifact of listArtifacts(registry)) {
          printDiffResult(await diffArtifact(artifact, artifact.name));
        }
      } catch (error) {
        console.error(chalk.red(`Error diffing managed ${type}:`), error.message);
        process.exitCode = 1;
      }
    });
}

registerArtifactNamespace('agent', 'agents', (registry) => registry.managedAgents || []);
registerArtifactNamespace('subagent', 'subagents', (registry) => registry.managedSubagents || []);
registerArtifactNamespace('hook', 'hooks', (registry) => registry.managedHooks || []);

program
  .command('validate')
  .description('Validate registry metadata, skill frontmatter, managed artifacts, and lock freshness')
  .action(async () => {
    try {
      const { errors, warnings } = await validateRegistry();
      for (const warning of warnings) console.log(chalk.yellow(`Warning: ${warning}`));

      if (errors.length > 0) {
        for (const error of errors) console.error(chalk.red(`Error: ${error}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green('Registry validation passed.'));
    } catch (error) {
      console.error(chalk.red('Error validating registry:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('lock')
  .description('Regenerate registry-lock.json with package-lock-like integrity entries')
  .action(async () => {
    try {
      await writeLock();
    } catch (error) {
      console.error(chalk.red('Error writing registry lock:'), error.message);
      process.exitCode = 1;
    }
  });

function registerLegacyDiffCommand(legacyName, replacement, listArtifacts) {
  program
    .command(legacyName, { hidden: true })
    .description(`Deprecated alias for "${replacement}"`)
    .action(async () => {
      try {
        console.log(chalk.gray(`Note: "${legacyName}" is deprecated; use "${replacement}".`));
        const registry = await readRegistry();
        for (const artifact of listArtifacts(registry)) {
          printDiffResult(await diffArtifact(artifact, artifact.name));
        }
      } catch (error) {
        console.error(chalk.red(`Error running ${legacyName}:`), error.message);
        process.exitCode = 1;
      }
    });
}

registerLegacyDiffCommand('diff-agents', 'agent diff', (registry) => registry.managedAgents || []);
registerLegacyDiffCommand('diff-subagents', 'subagent diff', (registry) => registry.managedSubagents || []);
registerLegacyDiffCommand('diff-hooks', 'hook diff', (registry) => registry.managedHooks || []);

program
  .command('stats')
  .argument('<action>', 'Only "record" is supported')
  .description('Record a usage-stats event: reads a JSON payload from stdin and appends metadata JSONL under $SKILL_FORGE_HOME/stats (default ~/.skill-forge/stats)')
  .action(async (action) => {
    try {
      if (action !== 'record') throw new Error(`Unsupported stats action "${action}". Use: record`);
      const stdin = await readStdin();
      let payload = {};
      try {
        payload = JSON.parse(stdin || '{}');
      } catch {
        throw new Error('stdin is not valid JSON');
      }
      const cwd = payload.cwd || process.cwd();
      const record = {
        schema: 1,
        ts: new Date().toISOString(),
        tool: payload.tool || 'unknown',
        event: payload.event || payload.hook_event_name || 'unknown',
        session_id: payload.session_id || null,
        project: path.basename(cwd),
        cwd,
        tool_name: payload.tool_name || null,
        agent_type: payload.agent_type || payload.tool_input?.subagent_type || null,
        model: payload.model || payload.tool_input?.model || null,
        description: payload.description || payload.tool_input?.description || null
      };
      const home = process.env.SKILL_FORGE_HOME || path.join(process.env.HOME, '.skill-forge');
      const statsDir = path.join(home, 'stats');
      await fs.ensureDir(statsDir);
      const slug = cwd.replace(/\//g, '-').replace(/^-/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
      await fs.appendFile(path.join(statsDir, `${slug}.jsonl`), `${JSON.stringify(record)}\n`);
      console.log(chalk.green(`Recorded ${record.event} for ${record.project}`));
    } catch (error) {
      console.error(chalk.red('Error recording stats:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('diff-global', { hidden: true })
  .description('Deprecated: compare custom inventory skills against global runtime skill targets')
  .action(async () => {
    try {
      console.log(chalk.yellow('Warning: "diff-global" is deprecated. Skills are project-scoped now; use "sync --check" in each profiled directory (including $HOME).'));
      const registry = await readRegistry();
      const globalSkills = registry.skills.filter((skill) => skill.runtimeTarget);
      for (const skill of sortSkills(globalSkills)) {
        printDiffResult(await diffArtifact(skill, skillKey(skill)));
      }
    } catch (error) {
      console.error(chalk.red('Error diffing global skills:'), error.message);
      process.exitCode = 1;
    }
  });

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseTomlSubagent(text) {
  const field = (name) => text.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || '';
  return { name: field('name'), description: field('description'), model: field('model') };
}

async function collectStats() {
  const home = process.env.SKILL_FORGE_HOME || path.join(process.env.HOME, '.skill-forge');
  const statsDir = path.join(home, 'stats');
  if (!await fs.pathExists(statsDir)) return { statsDir, projects: [] };

  const projects = new Map();
  for (const file of (await fs.readdir(statsDir)).filter((name) => name.endsWith('.jsonl'))) {
    const lines = (await fs.readFile(path.join(statsDir, file), 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const key = record.project || file;
      if (!projects.has(key)) projects.set(key, { project: key, events: 0, agents: new Map(), models: new Map(), lastTs: '' });
      const entry = projects.get(key);
      entry.events += 1;
      if (record.agent_type) entry.agents.set(record.agent_type, (entry.agents.get(record.agent_type) || 0) + 1);
      if (record.model) entry.models.set(record.model, (entry.models.get(record.model) || 0) + 1);
      if (record.ts > entry.lastTs) entry.lastTs = record.ts;
    }
  }
  return { statsDir, projects: [...projects.values()].sort((a, b) => b.events - a.events) };
}

function countMapToText(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} (${count})`).join(', ') || '—';
}

async function buildSiteHtml(registry) {
  const sections = [];

  const tagIndex = new Map();
  for (const skill of sortSkills(registry.skills)) {
    for (const tag of skill.tags || ['untagged']) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, []);
      tagIndex.get(tag).push(skill.name);
    }
  }
  const tagRows = [...tagIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, names]) => `<tr><td><span class="tag">${escapeHtml(tag)}</span></td><td>${names.map((name) => `<a href="#skill-${escapeHtml(name)}">${escapeHtml(name)}</a>`).join(', ')}</td></tr>`)
    .join('\n');

  const skillCards = [];
  for (const skill of sortSkills(registry.skills)) {
    const skillDir = path.join(REPO_ROOT, skill.path);
    const frontmatter = parseFrontmatter(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')) || {};
    const companions = (await fs.readdir(skillDir)).filter((name) => name !== 'SKILL.md');
    skillCards.push(`<article class="card" id="skill-${escapeHtml(skill.name)}">
<h3>${escapeHtml(skill.name)} <small>v${escapeHtml(skill.version)}</small></h3>
<p>${(skill.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ')}</p>
<p>${escapeHtml(frontmatter.description || '')}</p>
${companions.length > 0 ? `<p><small>Companions: ${companions.map(escapeHtml).join(', ')}</small></p>` : ''}
</article>`);
  }
  sections.push(`<section><h2>Skills (${registry.skills.length})</h2>
<h3>By tag</h3><table><thead><tr><th>Tag</th><th>Skills</th></tr></thead><tbody>${tagRows}</tbody></table>
${skillCards.join('\n')}</section>`);

  const agentBlocks = [];
  for (const artifact of (registry.managedAgents || []).filter((entry) => !entry.sourceOnly)) {
    const composed = await composeAgentContent(registry, artifact);
    const vars = Object.entries(artifact.vars || {}).map(([key, value]) => `${key} → ${value}`).join(', ');
    agentBlocks.push(`<article class="card"><h3>${escapeHtml(artifact.name)} <small>v${escapeHtml(artifact.version)} → ${escapeHtml(artifact.runtimeTarget)}</small></h3>
${vars ? `<p><small>Vars: ${escapeHtml(vars)}</small></p>` : ''}
<details><summary>Composed preview (${composed.split('\n').length} lines)</summary><pre>${escapeHtml(composed)}</pre></details></article>`);
  }
  sections.push(`<section><h2>Managed Agents</h2>${agentBlocks.join('\n')}</section>`);

  const subagentBlocks = [];
  for (const artifact of registry.managedSubagents || []) {
    const dir = path.join(REPO_ROOT, artifact.path);
    const rows = [];
    for (const file of (await fs.readdir(dir)).sort()) {
      const text = await fs.readFile(path.join(dir, file), 'utf8');
      const meta = file.endsWith('.toml') ? parseTomlSubagent(text) : (parseFrontmatter(text) || {});
      rows.push(`<tr><td>${escapeHtml(meta.name || file)}</td><td>${escapeHtml(meta.model || 'default')}</td><td>${escapeHtml(meta.tools || 'all')}</td><td>${escapeHtml(meta.description || '')}</td></tr>`);
    }
    subagentBlocks.push(`<article class="card"><h3>${escapeHtml(artifact.name)} <small>v${escapeHtml(artifact.version)} → ${escapeHtml(artifact.runtimeTarget)}</small></h3>
<table><thead><tr><th>Name</th><th>Model</th><th>Tools</th><th>Description</th></tr></thead><tbody>${rows.join('\n')}</tbody></table></article>`);
  }
  sections.push(`<section><h2>Managed Subagents</h2><p><small>Role sets intentionally differ per tool; Claude Code maps exploration/planning to built-in Explore/Plan.</small></p>${subagentBlocks.join('\n')}</section>`);

  const hookBlocks = [];
  for (const artifact of registry.managedHooks || []) {
    const files = await fs.readdir(path.join(REPO_ROOT, artifact.path));
    hookBlocks.push(`<article class="card"><h3>${escapeHtml(artifact.name)} <small>v${escapeHtml(artifact.version)} → ${escapeHtml(artifact.runtimeTarget)}</small></h3>
<p><small>Files: ${files.map(escapeHtml).join(', ')}</small></p></article>`);
  }
  if (hookBlocks.length > 0) sections.push(`<section><h2>Managed Hooks</h2>${hookBlocks.join('\n')}</section>`);

  const stats = await collectStats();
  if (stats.projects.length === 0) {
    sections.push(`<section><h2>Usage Stats</h2><p>No usage stats recorded yet in <code>${escapeHtml(stats.statsDir)}</code>. Install <code>claude-code-hooks</code> (merge the settings snippet) or <code>grok-hooks</code> (loads JSON under <code>~/.grok/hooks/</code>) to start recording.</p></section>`);
  } else {
    const statRows = stats.projects.map((entry) => `<tr><td>${escapeHtml(entry.project)}</td><td>${entry.events}</td><td>${escapeHtml(countMapToText(entry.agents))}</td><td>${escapeHtml(countMapToText(entry.models))}</td><td>${escapeHtml(entry.lastTs)}</td></tr>`).join('\n');
    sections.push(`<section><h2>Usage Stats</h2><p><small>Aggregated from ${escapeHtml(stats.statsDir)} — metadata only.</small></p>
<table><thead><tr><th>Project</th><th>Events</th><th>Agents</th><th>Models</th><th>Last activity</th></tr></thead><tbody>${statRows}</tbody></table></section>`);
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Forge Catalog</title>
<style>
:root { color-scheme: light dark; --border: #8884; --tagbg: #8882; }
body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 0 auto; padding: 1rem; }
h1 { margin-bottom: 0; } h1 + p { margin-top: 0.2rem; opacity: 0.7; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 0.4rem 1rem; margin: 0.7rem 0; }
.tag { background: var(--tagbg); border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.8rem; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid var(--border); padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
pre { overflow-x: auto; background: var(--tagbg); padding: 0.6rem; border-radius: 6px; }
small { opacity: 0.7; }
</style></head><body>
<h1>Skill Forge Catalog</h1>
<p>Generated ${new Date().toISOString()} from registry v${escapeHtml(registry.version)} — read-only preview of canonical inventory.</p>
${sections.join('\n')}
</body></html>\n`;
}

program
  .command('site')
  .description('Generate a static HTML catalog of skills, agents, subagents, hooks, and local usage stats')
  .option('-o, --out <dir>', 'Output directory', 'site')
  .action(async (options) => {
    try {
      const registry = await readRegistry();
      const outDir = path.resolve(options.out);
      await fs.ensureDir(outDir);
      const outFile = path.join(outDir, 'index.html');
      await fs.writeFile(outFile, await buildSiteHtml(registry));
      console.log(chalk.green(`Wrote ${outFile}`));
    } catch (error) {
      console.error(chalk.red('Error generating site:'), error.message);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
