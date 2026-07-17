import path from 'path';

/** Strict x.y.z only (no pre-release / build metadata). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseSemver(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid version "${version}". Use semver, e.g. "0.1.0".`);
  }
  const [major, minor, patch] = version.split('.').map(Number);
  return { major, minor, patch };
}

/**
 * @param {string} version
 * @param {'major'|'minor'|'patch'} level
 */
export function bumpSemver(version, level = 'patch') {
  const current = parseSemver(version);
  if (level === 'major') return `${current.major + 1}.0.0`;
  if (level === 'minor') return `${current.major}.${current.minor + 1}.0`;
  if (level === 'patch') return `${current.major}.${current.minor}.${current.patch + 1}`;
  throw new Error(`Invalid bump level "${level}". Use major, minor, or patch.`);
}

/** Reject absolute paths and `..` escapes for skill-relative destinations. */
export function assertSafeRelativePath(relPath, label = 'path') {
  if (path.isAbsolute(relPath)) throw new Error(`${label} "${relPath}" must be relative.`);
  const normalized = path.normalize(relPath);
  if (normalized === '.' || normalized.split(path.sep).includes('..')) {
    throw new Error(`${label} "${relPath}" must not escape the skill directory.`);
  }
  return normalized;
}

export function assertNoDuplicateRelPaths(relPaths, flagName) {
  const seen = new Set();
  for (const relPath of relPaths) {
    if (seen.has(relPath)) throw new Error(`Duplicate ${flagName} target "${relPath}"; each path may only be specified once.`);
    seen.add(relPath);
  }
}

/**
 * Resolve a registry skill path and ensure it is a strict child of inventory/skills
 * (not the inventory/skills directory itself).
 * @returns {string} absolute resolved path
 */
export function assertPathWithinInventorySkills(relPath, repoRoot) {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Registry entry has an absolute path "${relPath}"; refusing to use it.`);
  }
  const resolved = path.resolve(repoRoot, relPath);
  const boundary = path.resolve(repoRoot, 'inventory/skills');
  if (!resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`Registry entry path "${relPath}" escapes inventory/skills; refusing to use it.`);
  }
  return resolved;
}

/**
 * True when relPath names the skill-root SKILL.md, case-insensitively.
 * Nested paths like refs/skill.md are not reserved.
 */
export function isSkillMdRelPath(relPath) {
  const normalized = path.normalize(relPath);
  const base = path.basename(normalized);
  const dir = path.dirname(normalized);
  return (dir === '.' || dir === '') && base.toLowerCase() === 'skill.md';
}

/** Canonical form for skill-root SKILL.md paths; other relative paths unchanged. */
export function canonicalizeSkillRelPath(relPath) {
  return isSkillMdRelPath(relPath) ? 'SKILL.md' : relPath;
}

/**
 * Pure gate for reading SKILL.md from stdin (agent-facing non-interactive use).
 * Call only when SKILL.md is required and not supplied via --file SKILL.md=...
 */
export function assertSkillMdStdinAvailable(isTTY) {
  if (isTTY) {
    throw new Error('No SKILL.md source and stdin is a TTY. Pipe content, pass --file SKILL.md=<path>, or pass --skip-skill-md.');
  }
}
