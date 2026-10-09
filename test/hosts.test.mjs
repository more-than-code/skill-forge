import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOTE_COMMAND, isLoopbackHost, parseFacts, probeAll, probeHost } from '../lib/hosts.js';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');

const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

// A fake `ssh` that logs its argv and behaves per alias, so no test needs a real host.
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\\n');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_SSH_CONFIG, 'utf8'));
const dash = argv.indexOf('--');
const alias = dash >= 0 ? argv[dash + 1] : '';
const entry = cfg[alias] || {};
if (argv.includes('-G')) {
  process.stdout.write('hostname ' + (entry.hostname || alias) + '\\n');
  if (entry.proxycommand) process.stdout.write('proxycommand ' + entry.proxycommand + '\\n');
  process.exit(0);
}
const probe = entry.probe || { stdout: '', stderr: '', code: 0 };
setTimeout(() => {
  if (probe.stderr) process.stderr.write(probe.stderr);
  if (probe.stdout) process.stdout.write(probe.stdout);
  process.exit(probe.code || 0);
}, probe.hangMs || 0);
`;

const GOOD_FACTS = [
  'os=Linux', 'arch=aarch64', 'kernel=6.12.109+rpt-rpi-v8', 'mem_mb=7811', 'disk_free_gb=51',
  'bubblewrap=no', 'grok_version=grok 1.0.50 (c58f321264ba)', 'grok_procs=0', 'load1=0.41', 'temp_milli_c=56000'
].join('\n') + '\n';

async function fixture({ hosts, ssh = {}, fileMode = 0o600, raw } = {}) {
  const home = await tempDir('skf-hosts-home-');
  const bin = await tempDir('skf-fake-ssh-');
  const log = path.join(bin, 'ssh.log');
  const config = path.join(bin, 'ssh.json');
  await fs.writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  await fs.writeFile(config, JSON.stringify(ssh));
  await fs.writeFile(log, '');
  const file = path.join(home, 'hosts.json');
  if (hosts !== undefined || raw !== undefined) {
    await fs.writeFile(file, raw ?? JSON.stringify({ schema: 1, hosts }, null, 2), { mode: fileMode });
    await fs.chmod(file, fileMode);
  }
  const env = {
    ...process.env,
    SKILL_FORGE_HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_SSH_LOG: log,
    FAKE_SSH_CONFIG: config
  };
  return {
    home, file, env, log,
    calls: async () => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    hosts: async (args = []) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [CLI, 'home', 'hosts', ...args], { env });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      }
    }
  };
}

const PI = [{ name: 'pi1', ssh: 'pi1', dedicated: true }, { name: 'pi2', ssh: 'pi2' }];

test('home hosts: a missing file exits 1, names the path and shows an example', async () => {
  const fx = await fixture();
  const res = await fx.hosts();
  assert.equal(res.code, 1);
  assert.match(res.stderr, new RegExp(fx.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(res.stderr, /"schema": 1/);
  const json = JSON.parse((await fx.hosts(['--json'])).stdout);
  assert.match(json.error, /hosts\.json/);
});

test('home hosts: a valid file lists hosts in order, exits 0 and writes nothing', async () => {
  const fx = await fixture({ hosts: PI });
  const before = { files: await fs.readdir(fx.home), body: await fs.readFile(fx.file, 'utf8') };
  const res = await fx.hosts(['--json']);
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.schema, 1);
  assert.equal(out.file, fx.file);
  assert.deepEqual(out.hosts, [
    { name: 'pi1', ssh: 'pi1', dedicated: true },
    { name: 'pi2', ssh: 'pi2', dedicated: false }
  ]);
  assert.equal(out.hosts[0].status, undefined, 'no status without --probe');
  assert.deepEqual(await fs.readdir(fx.home), before.files, 'no file created');
  assert.equal(await fs.readFile(fx.file, 'utf8'), before.body, 'file untouched');
  assert.equal((await fx.calls()).length, 0, 'listing never runs ssh');
  const text = await fx.hosts();
  assert.match(text.stdout, /pi1[\s\S]*pi2/);
});

const INVALID = [
  ['unknown schema', { schema: 2, hosts: [] }, /schema/],
  ['unknown top-level key', { schema: 1, hosts: [], extra: 1 }, /extra/],
  ['hosts not an array', { schema: 1, hosts: {} }, /hosts/],
  ['duplicate name', { schema: 1, hosts: [{ name: 'a', ssh: 'a' }, { name: 'a', ssh: 'b' }] }, /duplicate/i],
  ['bad name', { schema: 1, hosts: [{ name: 'Pi4', ssh: 'pi4' }] }, /name/],
  ['alias starting with a dash', { schema: 1, hosts: [{ name: 'x', ssh: '-oProxyCommand=touch /tmp/x' }] }, /ssh/],
  ['alias with a space', { schema: 1, hosts: [{ name: 'x', ssh: 'a b' }] }, /ssh/],
  ['dedicated as a string', { schema: 1, hosts: [{ name: 'x', ssh: 'x', dedicated: 'true' }] }, /dedicated/],
  ['dedicated false', { schema: 1, hosts: [{ name: 'x', ssh: 'x', dedicated: false }] }, /dedicated/],
  ['misspelt key', { schema: 1, hosts: [{ name: 'x', ssh: 'x', dedicate: true }] }, /dedicate/]
];

for (const [label, body, pattern] of INVALID) {
  test(`home hosts: invalid file is refused (${label})`, async () => {
    const fx = await fixture({ raw: JSON.stringify(body) });
    const res = await fx.hosts(['--json', '--probe']);
    assert.equal(res.code, 1);
    assert.match(JSON.parse(res.stdout).error, pattern);
    assert.equal((await fx.calls()).length, 0, 'an invalid file never reaches ssh');
  });
}

test('home hosts: malformed JSON is refused', async () => {
  const fx = await fixture({ raw: '{ not json' });
  const res = await fx.hosts();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /JSON/);
});

test('home hosts: a group- or world-writable file is refused', async () => {
  for (const mode of [0o660, 0o606, 0o666]) {
    const fx = await fixture({ hosts: PI, fileMode: mode });
    const res = await fx.hosts(['--json']);
    assert.equal(res.code, 1, `mode ${mode.toString(8)}`);
    assert.match(JSON.parse(res.stdout).error, /writable|chmod/i);
  }
  const ok = await fixture({ hosts: PI, fileMode: 0o644 });
  assert.equal((await ok.hosts()).code, 0, 'readable by others is fine; only writable is refused');
});

test('home hosts --probe: every ssh call uses an argument array, --, and the hardened options', async () => {
  const fx = await fixture({
    hosts: PI,
    ssh: { pi1: { probe: { stdout: GOOD_FACTS } }, pi2: { probe: { stdout: GOOD_FACTS } } }
  });
  const res = await fx.hosts(['--probe', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const calls = await fx.calls();
  const probes = calls.filter((argv) => !argv.includes('-G'));
  const configs = calls.filter((argv) => argv.includes('-G'));
  assert.equal(probes.length, 2);
  assert.equal(configs.length, 2);
  for (const argv of probes) {
    const dash = argv.indexOf('--');
    assert.ok(dash > 0, 'a -- precedes the alias');
    assert.equal(argv.length, dash + 3, 'exactly alias and one remote command follow --');
    assert.equal(argv[dash + 2], REMOTE_COMMAND, 'the remote command is the constant');
    const opts = argv.slice(0, dash).join(' ');
    for (const needed of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=5', '-T']) {
      assert.ok(opts.includes(needed), `${needed} present`);
    }
  }
  for (const argv of configs) {
    assert.deepEqual(argv.slice(0, 2), ['-G', '--']);
  }
});

test('REMOTE_COMMAND never touches credentials or the environment', () => {
  for (const forbidden of ['auth.json', '.ssh', 'printenv', 'env', 'cat ~', '/.grok/auth', 'token', 'password']) {
    assert.ok(!REMOTE_COMMAND.includes(forbidden), `constant must not contain ${forbidden}`);
  }
});

test('home hosts --probe: facts are whitelisted and validated, raw output never appears', async () => {
  const noisy = GOOD_FACTS + 'password=hunter2\nsecret_token=abc\nmem_mb=not-a-number-but-dup\n';
  const fx = await fixture({
    hosts: [{ name: 'pi1', ssh: 'pi1', dedicated: true }],
    ssh: { pi1: { probe: { stdout: noisy, stderr: 'warning: some ssh banner text' } } }
  });
  const res = await fx.hosts(['--probe', '--json']);
  assert.equal(res.code, 0);
  assert.ok(!res.stdout.includes('hunter2') && !res.stdout.includes('secret_token') && !res.stdout.includes('banner'));
  const host = JSON.parse(res.stdout).hosts[0];
  assert.equal(host.status, 'reachable');
  assert.deepEqual(Object.keys(host.facts).sort(), [
    'arch', 'bubblewrap', 'diskFreeGb', 'grokProcs', 'grokVersion', 'kernel', 'load1', 'memMb', 'os', 'tempC'
  ]);
  assert.equal(host.facts.arch, 'aarch64');
  assert.equal(host.facts.bubblewrap, false);
  assert.equal(host.facts.grokVersion, 'grok 1.0.50 (c58f321264ba)');
  assert.equal(host.facts.tempC, 56);
  assert.equal(host.dedicated, true);
});

test('home hosts --probe: a missing or malformed value becomes null, not raw text', async () => {
  const partial = 'os=Linux\narch=aarch64\nmem_mb=lots\ngrok_version=\ntemp_milli_c=\nbubblewrap=maybe\n';
  const fx = await fixture({ hosts: [{ name: 'a', ssh: 'a' }], ssh: { a: { probe: { stdout: partial } } } });
  const host = JSON.parse((await fx.hosts(['--probe', '--json'])).stdout).hosts[0];
  assert.equal(host.status, 'reachable');
  assert.equal(host.facts.memMb, null);
  assert.equal(host.facts.grokVersion, null);
  assert.equal(host.facts.tempC, null);
  assert.equal(host.facts.bubblewrap, null);
});

test('home hosts --probe: reasons are classified, hosts are isolated, exit stays 0', async () => {
  const fx = await fixture({
    hosts: ['ok', 'nokey', 'noauth', 'nodns', 'broken', 'silent'].map((n) => ({ name: n, ssh: n })),
    ssh: {
      ok: { probe: { stdout: GOOD_FACTS } },
      nokey: { probe: { code: 255, stderr: 'Host key verification failed.\n' } },
      noauth: { probe: { code: 255, stderr: 'joe@x: Permission denied (publickey).\n' } },
      nodns: { probe: { code: 255, stderr: 'ssh: Could not resolve hostname nodns: Name or service not known\n' } },
      broken: { probe: { code: 255, stderr: 'something unexpected\n' } },
      silent: { probe: { code: 0, stdout: 'just a banner\n' } }
    }
  });
  const res = await fx.hosts(['--probe', '--json']);
  assert.equal(res.code, 0, 'unreachable hosts are data, not errors');
  const by = Object.fromEntries(JSON.parse(res.stdout).hosts.map((h) => [h.name, h]));
  assert.equal(by.ok.status, 'reachable');
  assert.deepEqual(
    ['nokey', 'noauth', 'nodns', 'broken', 'silent'].map((n) => [by[n].status, by[n].reason]),
    [['unknown', 'host-key-unverified'], ['unknown', 'auth-failed'], ['unknown', 'resolve-failed'],
      ['unknown', 'ssh-error'], ['unknown', 'bad-output']]
  );
  assert.ok(!res.stdout.includes('something unexpected') && !res.stdout.includes('publickey'));
});

test('home hosts --probe: an alias resolving to loopback is refused before any probe connection', async () => {
  const fx = await fixture({
    hosts: [
      { name: 'a', ssh: 'a' }, { name: 'b', ssh: 'b' }, { name: 'c', ssh: 'c' }, { name: 'd', ssh: 'd' }
    ],
    ssh: {
      a: { hostname: 'localhost' },
      b: { hostname: 'pi3.localhost' },
      c: { hostname: '127.0.0.1' },
      d: { hostname: '::1' }
    }
  });
  const res = await fx.hosts(['--probe', '--json']);
  assert.equal(res.code, 0);
  for (const host of JSON.parse(res.stdout).hosts) {
    assert.deepEqual([host.status, host.reason], ['unknown', 'loopback-alias'], host.name);
  }
  assert.ok((await fx.calls()).every((argv) => argv.includes('-G')), 'only -G ran, no probe connection');
});

test('home hosts --probe: a ProxyCommand is reported, not hidden', async () => {
  const fx = await fixture({
    hosts: [{ name: 'a', ssh: 'a' }],
    ssh: { a: { hostname: 'jump.example', proxycommand: 'nc %h %p', probe: { stdout: GOOD_FACTS } } }
  });
  const host = JSON.parse((await fx.hosts(['--probe', '--json'])).stdout).hosts[0];
  assert.equal(host.proxy, true);
  assert.equal(host.status, 'reachable');
});

test('probeAll: a hung host times out as unknown without holding back the others', async () => {
  const fx = await fixture({
    hosts: [],
    ssh: { slow: { probe: { hangMs: 8000, stdout: GOOD_FACTS } }, fast: { probe: { stdout: GOOD_FACTS } } }
  });
  const started = Date.now();
  const results = await probeAll(
    [{ name: 'slow', ssh: 'slow', dedicated: false }, { name: 'fast', ssh: 'fast', dedicated: false }],
    { env: fx.env, timeoutMs: 400 }
  );
  assert.ok(Date.now() - started < 4000, 'returns near the timeout, not after the hang');
  assert.deepEqual(results.map((r) => [r.name, r.status, r.reason ?? null]),
    [['slow', 'unknown', 'timeout'], ['fast', 'reachable', null]]);
});

test('probeHost: a missing ssh binary is an ssh-error, not a crash', async () => {
  const result = await probeHost({ name: 'a', ssh: 'a', dedicated: false }, { env: { ...process.env, PATH: '/nonexistent' } });
  assert.deepEqual([result.status, result.reason], ['unknown', 'ssh-error']);
});

test('home --help lists hosts', async () => {
  const { stdout } = await run(process.execPath, [CLI, 'home', '--help']);
  assert.match(stdout, /hosts/);
});

// --- hardening found in the post-implementation review ---

test('parseFacts: hostile key names from the remote side are ignored, never a crash', () => {
  for (const key of ['constructor', '__proto__', 'hasownproperty', 'tostring', 'valueof']) {
    const facts = parseFacts(`${key}=x\nos=Linux\n`);
    assert.equal(facts.os, 'Linux', key);
    assert.deepEqual(Object.keys(facts).sort(), [
      'arch', 'bubblewrap', 'diskFreeGb', 'grokProcs', 'grokVersion', 'kernel', 'load1', 'memMb', 'os', 'tempC'
    ]);
  }
  assert.equal(parseFacts('constructor=x\n__proto__=y\n'), null, 'nothing recognisable is bad output');
});

test('probeAll: one host that blows up cannot take the others down', async () => {
  const fx = await fixture({
    hosts: [],
    ssh: { odd: { probe: { stdout: 'constructor=x\n__proto__=y\nos=Linux\n' } }, fine: { probe: { stdout: GOOD_FACTS } } }
  });
  const results = await probeAll(
    [{ name: 'odd', ssh: 'odd', dedicated: false }, { name: 'fine', ssh: 'fine', dedicated: false }],
    { env: fx.env }
  );
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['odd', 'reachable'], ['fine', 'reachable']]);
});

test('probeHost: the timeout holds even when a grandchild keeps the output pipes open', async () => {
  const bin = await tempDir('skf-grandchild-');
  await fs.writeFile(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in *-G*) echo "hostname example.test"; exit 0;; esac',
    '( sleep 15 ) &',
    'sleep 15',
    ''
  ].join('\n'), { mode: 0o755 });
  const started = Date.now();
  const result = await probeHost(
    { name: 'x', ssh: 'x', dedicated: false },
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 400 }
  );
  assert.deepEqual([result.status, result.reason], ['unknown', 'timeout']);
  assert.ok(Date.now() - started < 4000, `returned after ${Date.now() - started} ms, not after the grandchild exits`);
});

test('home hosts --probe: the ssh options are exact, forwarding and multiplexing are off, nothing later overrides them', async () => {
  const fx = await fixture({ hosts: [{ name: 'a', ssh: 'a' }], ssh: { a: { probe: { stdout: GOOD_FACTS } } } });
  await fx.hosts(['--probe']);
  const argv = (await fx.calls()).find((call) => !call.includes('-G'));
  const dash = argv.indexOf('--');
  const options = argv.slice(0, dash);
  const pairs = [];
  for (let i = 0; i < options.length; i++) if (options[i] === '-o') pairs.push(options[++i]);
  assert.deepEqual(pairs, [
    'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=5', 'LogLevel=ERROR',
    'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none'
  ]);
  for (const flag of ['-T', '-a', '-x']) assert.ok(options.includes(flag), `${flag} present`);
});

test('isLoopbackHost: the usual loopback spellings are all caught, ordinary hosts are not', () => {
  for (const host of [
    'localhost', 'LOCALHOST', 'localhost.', 'pi3.localhost', 'pi3.localhost.', '127.0.0.1', '127.1', '127.255.255.254',
    '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::', '0.0.0.0', '2130706433', '0x7f000001', '0177.0.0.1'
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['pi4.local', 'example.com', '192.168.1.10', '10.0.0.1', '128.0.0.1', '::ffff:10.0.0.1', '2130706431', 'localhost.example.com']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('home hosts: aliases with shell metacharacters are refused, and every problem in a file is listed', async () => {
  for (const alias of ['a;b', 'a$b', 'a%b', 'a@b', 'a`b`', 'a|b', 'a&b', 'a\nb', 'a"b']) {
    const fx = await fixture({ hosts: [{ name: 'x', ssh: alias }] });
    assert.equal((await fx.hosts()).code, 1, JSON.stringify(alias));
  }
  const fx = await fixture({
    raw: JSON.stringify({ schema: 9, extra: 1, hosts: [{ name: 'Bad', ssh: '-o', dedicated: 'yes', typo: 1 }, { name: 'ok', ssh: 'ok' }, { name: 'ok', ssh: 'ok' }] })
  });
  const error = JSON.parse((await fx.hosts(['--json'])).stdout);
  assert.ok(error.problems.length >= 7, `all problems listed together: ${error.problems.length}`);
});

// --- SKILL_FORGE_HOME must not let a repo supply the trust file ---

async function runHostsAt({ env, cwd }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, 'home', 'hosts', '--json'], { env, cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function writeHostsAt(dir) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'hosts.json');
  await fs.writeFile(file, JSON.stringify({ schema: 1, hosts: [{ name: 'trap', ssh: 'trap', dedicated: true }] }), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

test('SKILL_FORGE_HOME: a relative override is refused, even when the file is valid and owned by you', async () => {
  const cwd = await tempDir('skf-cwd-');
  await writeHostsAt(path.join(cwd, 'home'));
  const res = await runHostsAt({ cwd, env: { ...process.env, SKILL_FORGE_HOME: 'home' } });
  assert.equal(res.code, 1);
  assert.match(JSON.parse(res.stdout).error, /SKILL_FORGE_HOME.*absolute/s);
});

test('SKILL_FORGE_HOME: an override inside the current directory is refused', async () => {
  const cwd = await tempDir('skf-cwd-');
  const dir = path.join(cwd, 'cloned', 'home');
  await writeHostsAt(dir);
  for (const home of [dir, cwd]) {
    const res = await runHostsAt({ cwd, env: { ...process.env, SKILL_FORGE_HOME: home } });
    assert.equal(res.code, 1, home);
    assert.match(JSON.parse(res.stdout).error, /current directory/);
  }
});

test('SKILL_FORGE_HOME: a directory whose name starts with ".." is still inside the current directory', async () => {
  const cwd = await tempDir('skf-cwd-');
  const dir = path.join(cwd, '..cloned');
  await writeHostsAt(dir);
  const res = await runHostsAt({ cwd, env: { ...process.env, SKILL_FORGE_HOME: dir } });
  assert.equal(res.code, 1, res.stdout);
  assert.match(JSON.parse(res.stdout).error, /current directory/);
});

test('SKILL_FORGE_HOME: a different-case spelling of the current directory is refused on a case-insensitive disk', async (t) => {
  const parent = await tempDir('skf-case-');
  const cwd = path.join(parent, 'Repo');
  await writeHostsAt(path.join(cwd, 'home'));
  const variant = path.join(parent, 'repo');
  if (!(await fs.stat(variant).then(() => true, () => false))) return t.skip('case-sensitive file system');
  const res = await runHostsAt({ cwd, env: { ...process.env, SKILL_FORGE_HOME: path.join(variant, 'home') } });
  assert.equal(res.code, 1, res.stdout);
  assert.match(JSON.parse(res.stdout).error, /current directory/);
});

test('SKILL_FORGE_HOME: an override inside a git work tree is refused, wherever the cwd is', async () => {
  const repo = await tempDir('skf-repo-');
  await fs.mkdir(path.join(repo, '.git'));
  const dir = path.join(repo, 'tools', 'home');
  await writeHostsAt(dir);
  const elsewhere = await tempDir('skf-elsewhere-');
  const res = await runHostsAt({ cwd: elsewhere, env: { ...process.env, SKILL_FORGE_HOME: dir } });
  assert.equal(res.code, 1);
  assert.match(JSON.parse(res.stdout).error, /git work tree/);
  // a worktree or submodule marks itself with a .git FILE, not a directory
  const linked = await tempDir('skf-linked-');
  await fs.writeFile(path.join(linked, '.git'), 'gitdir: /somewhere/else\n');
  const dir2 = path.join(linked, 'home');
  await writeHostsAt(dir2);
  const res2 = await runHostsAt({ cwd: elsewhere, env: { ...process.env, SKILL_FORGE_HOME: dir2 } });
  assert.equal(res2.code, 1);
  assert.match(JSON.parse(res2.stdout).error, /git work tree/);
});

test('SKILL_FORGE_HOME: an absolute override outside the cwd and outside any repo still works', async () => {
  const cwd = await tempDir('skf-cwd-');
  const home = await tempDir('skf-plain-home-');
  await writeHostsAt(home);
  const res = await runHostsAt({ cwd, env: { ...process.env, SKILL_FORGE_HOME: home } });
  assert.equal(res.code, 0, res.stdout);
  assert.equal(JSON.parse(res.stdout).hosts[0].dedicated, true);
});

test('the default ~/.skill-forge is trusted even when the cwd is $HOME or $HOME is a repo: the in-cwd and git-tree checks apply to the override only', async () => {
  const fakeHome = await tempDir('skf-fake-home-');
  await fs.mkdir(path.join(fakeHome, '.git'));
  await writeHostsAt(path.join(fakeHome, '.skill-forge'));
  const env = { ...process.env, HOME: fakeHome };
  delete env.SKILL_FORGE_HOME;
  const res = await runHostsAt({ cwd: fakeHome, env });
  assert.equal(res.code, 0, res.stdout);
  assert.equal(JSON.parse(res.stdout).hosts.length, 1);
});
