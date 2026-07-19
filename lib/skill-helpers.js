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

/** Exact "x.y.z" or npm-style "^x.y.z" / "~x.y.z" ranges. */
export const RANGE_PATTERN = /^[\^~]?\d+\.\d+\.\d+$/;

/**
 * npm semantics: exact matches exactly; "~" allows patch drift within the
 * minor; "^" allows compatible drift (leftmost non-zero component fixed).
 * @param {string} version
 * @param {string} range
 */
export function satisfiesRange(version, range) {
  const trimmed = String(range).trim();
  if (!RANGE_PATTERN.test(trimmed)) {
    throw new Error(`Invalid range "${range}". Use "x.y.z", "^x.y.z", or "~x.y.z".`);
  }
  const op = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '';
  const base = parseSemver(op ? trimmed.slice(1) : trimmed);
  const actual = parseSemver(version);
  const compare = (actual.major - base.major) || (actual.minor - base.minor) || (actual.patch - base.patch);

  if (op === '') return compare === 0;
  if (compare < 0) return false;
  if (op === '~') return actual.major === base.major && actual.minor === base.minor;
  if (base.major > 0) return actual.major === base.major;
  if (base.minor > 0) return actual.major === 0 && actual.minor === base.minor;
  return actual.major === 0 && actual.minor === 0 && actual.patch === base.patch;
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
