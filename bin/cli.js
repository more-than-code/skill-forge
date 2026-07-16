#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry.json');
const REGISTRY_LOCK_PATH = path.join(REPO_ROOT, 'registry-lock.json');
const SCOPE_PRIORITY = ['custom'];
const ARTIFACT_TYPES = ['skills', 'agents', 'subagents', 'hooks'];
const TOOL_LABELS = {
  codex: 'Codex',
  'copilot-cli': 'Copilot CLI',
  'claude-code': 'Claude Code'
};
const TOOL_SKILL_TARGETS = {
  codex: '~/.codex/skills',
  'copilot-cli': '~/.copilot/skills',
  'claude-code': '~/.claude/skills'
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

const program = new Command();

program
  .name('skill-forge')
  .description('CLI to manage skills from the skill-forge registry')
  .version('1.1.0');

function expandHome(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath === '~') return process.env.HOME;
  if (targetPath.startsWith('~/')) return path.join(process.env.HOME, targetPath.slice(2));
  return targetPath;
}

async function readRegistry() {
  return fs.readJson(REGISTRY_PATH);
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

async function buildPackageEntry(artifact) {
  const absolutePath = path.join(REPO_ROOT, artifact.path);
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

async function writeLock() {
  const registry = await readRegistry();
  const lock = await buildLock(registry);
  await fs.writeJson(REGISTRY_LOCK_PATH, lock, { spaces: 2 });
  console.log(chalk.green(`Wrote ${path.relative(process.cwd(), REGISTRY_LOCK_PATH)}`));
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
      default: defaultPath
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

function defaultTargetPath(type, artifacts, target) {
  if (type === 'skills') return TOOL_SKILL_TARGETS[target];
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
  const allArtifacts = getArtifactsByType(registry, type);
  const targetArtifacts = filterArtifactsForTarget(type, allArtifacts, target);
  if (targetArtifacts.length === 0) throw new Error(`No ${type} artifacts match target "${target}".`);

  const targetDefault = defaultTargetPath(type, targetArtifacts, target);
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

program
  .command('add [skillName]')
  .description('Install specific skill(s); use install for agents and subagents')
  .option('-d, --dir <path>', 'Destination directory for skills')
  .option('--target <tool>', 'Target tool for default path selection')
  .option('-y, --yes', 'Overwrite existing target paths without prompting')
  .action(async (skillName, options) => {
    try {
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
    .option('--target <tool>', 'Target tool: codex, copilot-cli, or claude-code')
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

program
  .command('diff-agents')
  .description('Compare managed AGENTS artifacts against their runtime targets without writing')
  .action(async () => {
    try {
      const registry = await readRegistry();
      for (const artifact of registry.managedAgents) {
        printDiffResult(await diffArtifact(artifact, artifact.name));
      }
    } catch (error) {
      console.error(chalk.red('Error diffing managed agents:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('diff-subagents')
  .description('Compare managed subagent artifacts against their runtime targets without writing')
  .action(async () => {
    try {
      const registry = await readRegistry();
      for (const artifact of registry.managedSubagents || []) {
        printDiffResult(await diffArtifact(artifact, artifact.name));
      }
    } catch (error) {
      console.error(chalk.red('Error diffing managed subagents:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('diff-hooks')
  .description('Compare managed hook artifacts against their runtime targets without writing')
  .action(async () => {
    try {
      const registry = await readRegistry();
      for (const artifact of registry.managedHooks || []) {
        printDiffResult(await diffArtifact(artifact, artifact.name));
      }
    } catch (error) {
      console.error(chalk.red('Error diffing managed hooks:'), error.message);
      process.exitCode = 1;
    }
  });

program
  .command('stats')
  .argument('<action>', 'Only "record" is supported')
  .description('Record a usage-stats event: reads a JSON payload from stdin and appends metadata JSONL under $SKILL_FORGE_HOME/stats (default ~/.skill-forge/stats)')
  .action(async (action) => {
    try {
      if (action !== 'record') throw new Error(`Unsupported stats action "${action}". Use: record`);
      const stdin = await new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
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
  .command('diff-global')
  .description('Compare custom inventory skills against global runtime skill targets without writing')
  .action(async () => {
    try {
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
    sections.push(`<section><h2>Usage Stats</h2><p>No usage stats recorded yet in <code>${escapeHtml(stats.statsDir)}</code>. Install the claude-code-hooks artifact and merge the settings snippet to start recording.</p></section>`);
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
