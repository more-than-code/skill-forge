import fs from 'fs-extra';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';

// Declared remote hosts for this machine, and a read-only probe of them.
//
// The file is written by the user, never by this CLI or an agent: `dedicated: true` is a trust
// grant (it is what makes `--sandbox off` acceptable for a delegated run), and a probe can
// measure facts about a host but can never establish that.

export const HOSTS_SCHEMA = 1;
export const PROBE_TIMEOUT_MS = 15000;

const CONFIG_TIMEOUT_MS = 5000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const PROBE_CONCURRENCY = 8;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOP_LEVEL_KEYS = new Set(['schema', 'hosts']);
const HOST_KEYS = new Set(['name', 'ssh', 'dedicated']);

const EXAMPLE = `{
  "schema": 1,
  "hosts": [
    { "name": "pi4", "ssh": "pi4", "dedicated": true }
  ]
}`;

export class HostsFileError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'HostsFileError';
    this.problems = problems;
  }
}

// The OS realpath, not the JS one: on a case-insensitive disk only it returns the stored case, so
// `/x/repo` and `/x/Repo` compare equal.
const realpathNative = promisify(fs.realpath.native);

// Resolve symlinks for the deepest part that exists, so a missing directory still compares correctly.
async function realpathLoose(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(await realpathNative(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  // `..cloned` is a child; only `..` itself or a `../` prefix leaves the parent
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function enclosingGitRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    // a directory for a repository, a file for a linked worktree or submodule
    if (await fs.pathExists(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/**
 * Where hosts.json lives. The default (`~/.skill-forge`) is the user's own and is trusted. An
 * explicit SKILL_FORGE_HOME is not: a repository can set it for an agent session, and a cloned
 * file is owned by you with an ordinary mode, so it would pass the owner and mode checks and
 * grant `dedicated`. The override therefore has to be absolute, outside the current directory and
 * outside any git work tree. This closes the one variable meant for relocating the file; it is not
 * a defence against whoever controls the whole environment (HOME, or PATH to a fake `skf`).
 */
export async function resolveHostsFile(env = process.env, cwd = process.cwd()) {
  const override = env.SKILL_FORGE_HOME;
  if (!override) return path.join(env.HOME || os.homedir(), '.skill-forge', 'hosts.json');

  const refuse = (why) => new HostsFileError(
    `Refusing SKILL_FORGE_HOME=${override}: hosts.json is a trust file, so ${why} ` +
    'Unset SKILL_FORGE_HOME to use ~/.skill-forge.'
  );
  if (!path.isAbsolute(override)) throw refuse('an override must be an absolute path.');

  const dir = await realpathLoose(override);
  const here = await realpathLoose(cwd);
  if (isWithin(dir, here)) throw refuse(`it must not be inside the current directory (${here}).`);
  const repo = await enclosingGitRoot(dir);
  if (repo) throw refuse(`it must not be inside a git work tree (${repo}).`);
  return path.join(override, 'hosts.json');
}

/** Validate a parsed document. Returns every problem found, so one run shows them all. */
export function validateHostsDocument(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { hosts: [], problems: ['the file must contain a JSON object'] };
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown key "${key}" at the top level`);
  }
  if (doc.schema !== HOSTS_SCHEMA) {
    problems.push(`unsupported schema ${JSON.stringify(doc.schema)} (expected ${HOSTS_SCHEMA})`);
  }
  if (!Array.isArray(doc.hosts)) {
    problems.push('hosts must be an array');
    return { hosts: [], problems };
  }

  const seen = new Set();
  const hosts = [];
  doc.hosts.forEach((entry, index) => {
    const where = `hosts[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!HOST_KEYS.has(key)) problems.push(`${where} has unknown key "${key}"`);
    }
    if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
      problems.push(`${where}.name ${JSON.stringify(entry.name)} must match ${NAME_PATTERN}`);
    } else if (seen.has(entry.name)) {
      problems.push(`${where}.name "${entry.name}" is a duplicate`);
    } else {
      seen.add(entry.name);
    }
    if (typeof entry.ssh !== 'string' || !ALIAS_PATTERN.test(entry.ssh)) {
      problems.push(`${where}.ssh ${JSON.stringify(entry.ssh)} must be an ssh alias matching ${ALIAS_PATTERN}`);
    }
    if ('dedicated' in entry && entry.dedicated !== true) {
      problems.push(`${where}.dedicated must be the boolean true, or omitted`);
    }
    hosts.push({ name: entry.name, ssh: entry.ssh, dedicated: entry.dedicated === true });
  });
  return { hosts: problems.length ? [] : hosts, problems };
}

/** Read and validate the declared hosts. Refuses a file anyone but the owner can write. */
export async function loadHostsFile(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HostsFileError(
        `No hosts declared: ${filePath} does not exist.\nCreate it by hand (an agent must not write it), for example:\n${EXAMPLE}`
      );
    }
    throw new HostsFileError(`Cannot read ${filePath}: ${error.code || error.message}`);
  }
  if (!stat.isFile()) throw new HostsFileError(`${filePath} is not a regular file.`);
  if (typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) {
      throw new HostsFileError(`Refusing to read ${filePath}: it is owned by another user.`);
    }
    if (stat.mode & 0o022) {
      throw new HostsFileError(
        `Refusing to read ${filePath}: it is writable by group or others. Run: chmod 600 ${filePath}`
      );
    }
  }

  let doc;
  try {
    doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new HostsFileError(`${filePath} is not valid JSON: ${error.message}`);
  }
  const { hosts, problems } = validateHostsDocument(doc);
  if (problems.length) {
    throw new HostsFileError(`Invalid ${filePath}:\n${problems.map((p) => `  - ${p}`).join('\n')}`, problems);
  }
  return hosts;
}

// One fixed remote command. No declared value is ever interpolated into it, and it reads nothing
// that holds credentials. Every line it prints is `key=value`, and only whitelisted keys survive
// parsing. sshd runs it as `$SHELL -c`, so it assumes a POSIX-compatible shell for that account
// (fish or csh gives `bad-output`); a missing tool just yields an empty value.
export const REMOTE_COMMAND = [
  `echo "os=$(uname -s)"`,
  `echo "arch=$(uname -m)"`,
  `echo "kernel=$(uname -r)"`,
  `m=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null); echo "mem_mb=$m"`,
  `d=$(df -Pk / 2>/dev/null | awk 'NR==2{printf "%d", $4/1048576}'); echo "disk_free_gb=$d"`,
  `if command -v bwrap >/dev/null 2>&1; then echo bubblewrap=yes; else echo bubblewrap=no; fi`,
  `g=$(command -v grok 2>/dev/null); [ -z "$g" ] && [ -x "$HOME/.grok/bin/grok" ] && g="$HOME/.grok/bin/grok"; ` +
    `if [ -n "$g" ]; then echo "grok_version=$("$g" --version 2>/dev/null | head -n 1)"; else echo grok_version=; fi`,
  `echo "grok_procs=$(pgrep -x grok 2>/dev/null | wc -l | tr -d ' ')"`,
  `echo "load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null)"`,
  `echo "temp_milli_c=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"`
].join('; ');

const FACT_SPECS = {
  os: ['os', /^[A-Za-z0-9._ -]{1,32}$/, (v) => v],
  arch: ['arch', /^[A-Za-z0-9_-]{1,16}$/, (v) => v],
  kernel: ['kernel', /^[A-Za-z0-9._+~-]{1,64}$/, (v) => v],
  mem_mb: ['memMb', /^\d{1,9}$/, Number],
  disk_free_gb: ['diskFreeGb', /^\d{1,7}$/, Number],
  bubblewrap: ['bubblewrap', /^(yes|no)$/, (v) => v === 'yes'],
  grok_version: ['grokVersion', /^grok \d+\.\d+\.\d+[A-Za-z0-9._+() -]{0,48}$/, (v) => v],
  grok_procs: ['grokProcs', /^\d{1,4}$/, Number],
  load1: ['load1', /^\d{1,4}(\.\d{1,4})?$/, Number],
  temp_milli_c: ['tempC', /^\d{1,7}$/, (v) => Math.round(Number(v) / 100) / 10]
};

/** Keep only whitelisted, validated values. Returns null when nothing recognisable came back. */
export function parseFacts(stdout) {
  const facts = Object.fromEntries(Object.values(FACT_SPECS).map(([name]) => [name, null]));
  const seen = new Set();
  let recognised = false;
  for (const line of String(stdout).split('\n')) {
    const match = /^([a-z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ''));
    // Own keys only: the remote side controls these names, and `constructor` or `__proto__`
    // would otherwise resolve to something inherited.
    if (!match || !Object.hasOwn(FACT_SPECS, match[1]) || seen.has(match[1])) continue;
    seen.add(match[1]);
    recognised = true;
    const [name, pattern, convert] = FACT_SPECS[match[1]];
    const value = match[2].trim();
    if (pattern.test(value)) facts[name] = convert(value);
  }
  return recognised ? facts : null;
}

function parseSshConfigDump(stdout) {
  let hostname = '';
  let proxy = false;
  for (const line of String(stdout).split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    const value = rest.join(' ');
    if (key === 'hostname') hostname = value;
    if ((key === 'proxycommand' || key === 'proxyjump') && value && value.toLowerCase() !== 'none') proxy = true;
  }
  return { hostname, proxy };
}

// IPv4 rules also match IPv4-mapped IPv6 addresses (::ffff:127.0.0.1).
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addAddress('::', 'ipv6');

// getaddrinfo also accepts 1 to 4 numeric parts, each decimal, 0x-hex or 0-octal, where the last
// part fills the remaining bytes (2130706433, 0x7f000001, 0177.0.0.1, 127.1). Returns dotted quad or null.
function parseInetAton(host) {
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const values = [];
  for (const part of parts) {
    if (/^0x[0-9a-f]+$/.test(part)) values.push(parseInt(part, 16));
    else if (/^0[0-7]*$/.test(part)) values.push(parseInt(part || '0', 8));
    else if (/^[1-9]\d*$/.test(part)) values.push(parseInt(part, 10));
    else return null;
  }
  const last = values.pop();
  if (values.some((v) => v > 255) || last >= 256 ** (4 - values.length)) return null;
  const address = values.reduce((sum, v, i) => sum + v * 256 ** (3 - i), last);
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join('.');
}

/** Best effort: spellings of loopback that need no DNS. A name that DNS maps to loopback is not caught. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIPv6(host)) return LOOPBACK.check(host, 'ipv6');
  const dotted = net.isIPv4(host) ? host : parseInetAton(host);
  return dotted !== null && LOOPBACK.check(dotted, 'ipv4');
}

function reasonFromStderr(stderr) {
  const text = String(stderr);
  if (/host key verification failed|remote host identification has changed|no [\w-]+ host key is known/i.test(text)) {
    return 'host-key-unverified';
  }
  if (/permission denied/i.test(text)) return 'auth-failed';
  if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(text)) return 'resolve-failed';
  if (/timed out/i.test(text)) return 'timeout';
  return 'ssh-error';
}

// Always an argument array (never a shell), always `--` before the alias. Command-line options
// override the user's ssh config, so a new host key is never accepted silently, no agent or port
// is forwarded to a host that may run unsandboxed work, no local command runs, and no existing
// multiplexed connection is reused (it would skip the host-key check).
function probeArgs(alias) {
  return [
    '-T', '-a', '-x',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '--', alias, REMOTE_COMMAND
  ];
}

function capture(argv, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...extra });
    };
    let child;
    try {
      child = spawn('ssh', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ spawnError: error.code || 'EXEC' });
      return;
    }
    // End on the timer itself. `close` waits for every pipe, and a grandchild (a ProxyCommand, a
    // lingering connection helper) can hold them open long after ssh is killed.
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += text; });
    child.stderr.on('data', (text) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += text; });
    child.on('error', (error) => finish({ spawnError: error.code || 'EXEC' }));
    child.on('close', (code) => finish({ code }));
  });
}

/** Probe one declared host. Never throws: every failure becomes `unknown` plus a reason. */
export async function probeHost(host, { env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = { name: host.name, ssh: host.ssh, dedicated: host.dedicated === true };
  const unknown = (reason, proxy = false) => ({ ...base, status: 'unknown', reason, proxy });

  const config = await capture(['-G', '--', host.ssh], { env, timeoutMs: CONFIG_TIMEOUT_MS });
  if (config.spawnError || config.timedOut || config.code !== 0) return unknown('ssh-error');
  const { hostname, proxy } = parseSshConfigDump(config.stdout);
  if (isLoopbackHost(hostname)) return unknown('loopback-alias', proxy);

  const result = await capture(probeArgs(host.ssh), { env, timeoutMs });
  if (result.spawnError) return unknown('ssh-error', proxy);
  if (result.timedOut) return unknown('timeout', proxy);
  if (result.code !== 0) return unknown(reasonFromStderr(result.stderr), proxy);
  const facts = parseFacts(result.stdout);
  if (!facts) return unknown('bad-output', proxy);
  return { ...base, status: 'reachable', proxy, facts };
}

/** Probe hosts in parallel (a small pool); results keep the declared order. */
export async function probeAll(hosts, options = {}) {
  const results = new Array(hosts.length);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const index = next++;
      const host = hosts[index];
      // probeHost does not throw by design; this keeps one host's surprise from losing the others.
      results[index] = await probeHost(host, options).catch(() => (
        { name: host.name, ssh: host.ssh, dedicated: host.dedicated === true, status: 'unknown', reason: 'ssh-error', proxy: false }
      ));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, hosts.length) }, worker));
  return results;
}
