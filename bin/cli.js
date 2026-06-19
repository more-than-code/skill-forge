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

const CONFIG_FILE = '.skillforge.json';
const REPO_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry.json');
const REGISTRY_LOCK_PATH = path.join(REPO_ROOT, 'registry-lock.json');
const DEFAULT_INSTALL_DIR = '.skills';

const SCOPE_PRIORITY = ['custom'];

const program = new Command();

program
  .name('skill-forge')
  .description('CLI to manage skills from the skill-forge registry')
  .version('1.0.0');

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

  return {
    name: artifact.name,
    version: artifact.version,
    type: artifact.type,
    scope: artifact.scope,
    installable: artifact.installable,
    runtimeTarget: artifact.runtimeTarget,
    integrity,
    files
  };
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

  for (const artifact of registry.managedAgents) {
    packages[path.dirname(artifact.path)] = await buildPackageEntry(artifact);
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

  for (const artifact of registry.managedAgents || []) {
    for (const field of ['name', 'version', 'path', 'runtimeTarget']) {
      if (!artifact[field]) reportValidationError(errors, `managed agent missing ${field}`);
    }
    if (artifact.path && !await fs.pathExists(path.join(REPO_ROOT, artifact.path))) {
      reportValidationError(errors, `${artifact.name} missing file at ${artifact.path}`);
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

  const sourcePath = path.join(REPO_ROOT, artifact.path);
  const targetPath = expandHome(artifact.runtimeTarget);
  if (!await fs.pathExists(targetPath)) return { status: 'missing', label, targetPath };

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
  .description('Install specific skill(s) into your project')
  .option('-d, --dir <path>', 'Destination directory')
  .action(async (skillName, options) => {
    try {
      const registry = await readRegistry();
      const installableSkills = getSkillEntries(registry, { installableOnly: true });
      const configPath = path.join(process.cwd(), CONFIG_FILE);
      let skillsToInstall = [];

      if (skillName) {
        const resolved = resolveSkill(registry, skillName);
        if (!resolved.skill) {
          console.error(chalk.red(`Error: Skill "${skillName}" not found.`));
          process.exitCode = 1;
          return;
        }
        if (!resolved.skill.installable) {
          console.error(chalk.red(`Error: Skill "${skillName}" is tracked but not installable.`));
          process.exitCode = 1;
          return;
        }
        if (resolved.ambiguous) {
          console.log(chalk.yellow(`> Multiple skills named "${skillName}" found; using ${skillKey(resolved.skill)}.`));
          console.log(chalk.gray(`> Use a scoped name like ${resolved.matches.map(skillKey).join(' or ')} to be explicit.`));
        }
        skillsToInstall.push(resolved.skill);
      } else {
        const answers = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'selectedSkills',
            message: 'Which skills would you like to install?',
            choices: installableSkills.map((skill) => ({
              name: `${skillKey(skill)} (v${skill.version})`,
              value: skillKey(skill)
            })),
            validate: (answer) => answer.length < 1 ? 'You must choose at least one skill.' : true
          }
        ]);
        skillsToInstall = answers.selectedSkills.map((selected) => resolveSkill(registry, selected).skill);
      }

      let installDir = options.dir;
      if (!installDir && await fs.pathExists(configPath)) {
        try {
          const config = await fs.readJson(configPath);
          if (config.installDir) {
            installDir = config.installDir;
            console.log(chalk.gray(`> Using saved install directory: ${installDir}`));
          }
        } catch {
          // Ignore invalid config; prompt below.
        }
      }

      if (!installDir) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'dir',
            message: 'Where should skills be installed?',
            default: DEFAULT_INSTALL_DIR
          }
        ]);
        installDir = answer.dir;
        await fs.writeJson(configPath, { installDir }, { spaces: 2 });
        console.log(chalk.gray(`> Saved preference to ${CONFIG_FILE}`));
      }

      console.log(chalk.blue(`\nInstalling ${skillsToInstall.length} skill(s) to "${installDir}/"...\n`));
      for (const skill of skillsToInstall) {
        const sourcePath = path.join(REPO_ROOT, skill.path);
        const destPath = path.join(process.cwd(), installDir, skill.name);

        if (await fs.pathExists(destPath)) {
          console.log(chalk.yellow(`  Updating existing skill: ${skill.name}`));
        }

        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(sourcePath, destPath);
        console.log(chalk.green(`  ${skillKey(skill)}`));
      }

      console.log(chalk.blue('\nDone!'));
    } catch (error) {
      console.error(chalk.red('Error installing skill:'), error.message);
      process.exitCode = 1;
    }
  });

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

program.parse(process.argv);
