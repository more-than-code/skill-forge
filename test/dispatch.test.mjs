import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(REPO_ROOT, 'inventory', 'skills', 'external-worker-delegation', 'dispatch.sh');

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
};

async function git(cwd, args) {
  return run('git', args, { cwd, env: GIT_ENV });
}

function resolveGitPath(repo, printed) {
  return path.isAbsolute(printed) ? printed : path.join(repo, printed);
}

async function dispatchRepo() {
  const parent = await tempDir('skf-dispatch-');
  const repo = path.join(parent, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return {
    repo,
    tree(slug) {
      return path.join(parent, `work-${slug}`);
    },
    dispatch(args, opts = {}) {
      return run('sh', [DISPATCH, ...args], { cwd: repo, env: GIT_ENV, ...opts });
    },
    dispatchFrom(cwd, args, opts = {}) {
      return run('sh', [DISPATCH, ...args], { cwd, env: GIT_ENV, ...opts });
    },
    async excludePath() {
      const { stdout } = await git(repo, ['rev-parse', '--git-common-dir']);
      return path.join(resolveGitPath(repo, stdout.trim()), 'info', 'exclude');
    }
  };
}

function failed(error) {
  assert.ok(error && error.code !== 0, 'expected a non-zero exit');
  return error;
}

test('dispatch usage and environment errors', async () => {
  const fx = await dispatchRepo();
  assert.equal(failed(await fx.dispatch([]).catch((error) => error)).code, 64);
  assert.equal(failed(await fx.dispatch(['-bad', '--', 'true']).catch((error) => error)).code, 64);
  assert.equal(failed(await fx.dispatch(['demo']).catch((error) => error)).code, 64);

  const bare = await tempDir('skf-nongit-');
  const noGit = failed(await run('sh', [DISPATCH, 'demo', '--', 'true'], { cwd: bare, env: GIT_ENV }).catch((error) => error));
  assert.equal(noGit.code, 69);
  assert.match(noGit.stderr, /not a git repository/);
});

test('first dispatch creates a worktree and seeds info/exclude; second first-run is idempotent', async () => {
  const fx = await dispatchRepo();
  const { stdout } = await fx.dispatch(['demo', '--', 'true']);
  assert.match(stdout, /Worktree ready/);
  assert.match(stdout, /BRIEF\.md/);
  await fs.access(fx.tree('demo'));
  await git(fx.repo, ['show-ref', '--verify', '--quiet', 'refs/heads/worker/demo']);

  const exclude = await fs.readFile(await fx.excludePath(), 'utf8');
  assert.match(exclude, /# >>> skill-forge worker >>>/);
  assert.match(exclude, /^BRIEF\.md$/m);
  assert.match(exclude, /^NOTES\.md$/m);
  assert.match(exclude, /# <<< skill-forge worker <<</);

  // Fresh worktree is already an ancestor of HEAD, so --remove without --force is allowed.
  await fx.dispatch(['demo', '--remove']);
  await fx.dispatch(['demo', '--', 'true']);
  const again = await fs.readFile(await fx.excludePath(), 'utf8');
  assert.equal(again.match(/# >>> skill-forge worker >>>/g).length, 1);
});

test('dispatch refuses a linked worktree and requires a Role brief before exec', async () => {
  const fx = await dispatchRepo();
  await fx.dispatch(['demo', '--', 'true']);

  const nested = failed(await fx.dispatchFrom(fx.tree('demo'), ['nested', '--', 'true']).catch((error) => error));
  assert.equal(nested.code, 69);
  assert.match(nested.stderr, /linked worktree/);

  const missing = failed(await fx.dispatch(['demo', '--', 'true']).catch((error) => error));
  assert.equal(missing.code, 66);
  assert.match(missing.stderr, /BRIEF\.md is missing/);

  await fs.writeFile(path.join(fx.tree('demo'), 'BRIEF.md'), '# Brief\n\nNo role heading.\n');
  const noRole = failed(await fx.dispatch(['demo', '--', 'true']).catch((error) => error));
  assert.equal(noRole.code, 65);
  assert.match(noRole.stderr, /no '## Role' section/);

  await fs.writeFile(path.join(fx.tree('demo'), 'BRIEF.md'), '## Role\n\nYou are the worker.\n');
  const { stdout } = await fx.dispatch([
    'demo',
    '--',
    'sh',
    '-c',
    'echo "$SKILL_FORGE_AGENT_ROLE"; pwd'
  ]);
  const [role, cwd] = stdout.trim().split('\n');
  assert.equal(role, 'worker');
  assert.equal(await fs.realpath(cwd), await fs.realpath(fx.tree('demo')));
});

test('--remove refuses an unmerged branch unless --force or the branch is merged', async () => {
  const fx = await dispatchRepo();
  await fx.dispatch(['demo', '--', 'true']);
  await git(fx.tree('demo'), ['commit', '-q', '--allow-empty', '-m', 'work']);

  const refused = failed(await fx.dispatch(['demo', '--remove']).catch((error) => error));
  assert.equal(refused.code, 65);
  assert.match(refused.stderr, /not merged into HEAD/);
  await fs.access(fx.tree('demo'));
  await git(fx.repo, ['show-ref', '--verify', '--quiet', 'refs/heads/worker/demo']);

  await git(fx.repo, ['merge', '-q', '--no-edit', 'worker/demo']);
  const { stdout: removed } = await fx.dispatch(['demo', '--remove']);
  assert.match(removed, /Removed/);
  await assert.rejects(fs.access(fx.tree('demo')));
  const gone = failed(await git(fx.repo, ['show-ref', '--verify', '--quiet', 'refs/heads/worker/demo']).catch((error) => error));
  assert.equal(gone.code, 1);

  await fx.dispatch(['other', '--', 'true']);
  await git(fx.tree('other'), ['commit', '-q', '--allow-empty', '-m', 'discard']);
  await fx.dispatch(['other', '--remove', '--force']);
  await assert.rejects(fs.access(fx.tree('other')));
});

test('exclude block covers ledger and run artifacts, upgrades a stale block, and spares tracked files', async () => {
  const fx = await dispatchRepo();
  // A block written by an older version of dispatch.sh, missing the later entries.
  const exclude = await fx.excludePath();
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, '# >>> skill-forge worker >>>\nBRIEF.md\nNOTES.md\n# <<< skill-forge worker <<<\n');
  // A committed pointer stub: info/exclude must not be able to hide it.
  await fs.mkdir(path.join(fx.repo, 'tasks'), { recursive: true });
  await fs.writeFile(path.join(fx.repo, 'tasks', 'todo.md'), 'pointer stub\n');
  await git(fx.repo, ['add', 'tasks/todo.md']);
  await git(fx.repo, ['commit', '-q', '-m', 'stub']);

  await fx.dispatch(['demo', '--', 'true']);

  const upgraded = await fs.readFile(exclude, 'utf8');
  assert.equal(upgraded.match(/# >>> skill-forge worker >>>/g).length, 1, 'stale block is rewritten, not duplicated');
  for (const entry of ['BRIEF\\.md', 'NOTES\\.md', 'tasks/', 'run\\.jsonl', 'driver\\.log']) {
    assert.match(upgraded, new RegExp(`^${entry}$`, 'm'));
  }

  const tree = fx.tree('demo');
  await fs.writeFile(path.join(tree, 'NOTES.md'), 'handoff\n');
  await fs.writeFile(path.join(tree, 'run.jsonl'), '{}\n');
  await fs.writeFile(path.join(tree, 'driver.log'), 'iteration 1\n');
  await fs.writeFile(path.join(tree, 'tasks', 'notes.md'), 'ledger\n');
  const { stdout: status } = await git(tree, ['status', '--short']);
  assert.equal(status.trim(), '', 'orchestrator files stay invisible to a worker\'s git add -A');

  // Excluding tasks/ must not drop the stub the worker is meant to find.
  const { stdout: tracked } = await git(tree, ['ls-files', 'tasks/']);
  assert.equal(tracked.trim(), 'tasks/todo.md');
});

test('--remove reports the accumulated worker cost before deleting run.jsonl', async () => {
  const fx = await dispatchRepo();
  await fx.dispatch(['demo', '--', 'true']);
  // One `end` record per driver iteration; the ticks field must not be summed with them.
  await fs.writeFile(
    path.join(fx.tree('demo'), 'run.jsonl'),
    '{"type":"end","total_cost_usd":0.5,"total_cost_usd_ticks":9900}\n' +
    '{"type":"end","total_cost_usd":1.25}\n'
  );

  const { stdout } = await fx.dispatch(['demo', '--remove']);
  assert.match(stdout, /Worker cost before teardown: \$1\.7500 over 2 iteration\(s\)/);
  assert.match(stdout, /Removed/);

  // No run log: teardown stays quiet rather than printing a zero.
  await fx.dispatch(['quiet', '--', 'true']);
  const { stdout: silent } = await fx.dispatch(['quiet', '--remove']);
  assert.doesNotMatch(silent, /Worker cost/);
});

test('--remove refuses a dirty worktree even when the branch has no commits', async () => {
  const fx = await dispatchRepo();
  await fx.dispatch(['demo', '--', 'true']);
  // The worker wrote code and never committed: the branch is trivially an ancestor of
  // HEAD, so only a working-tree check stands between this and deletion.
  await fs.writeFile(path.join(fx.tree('demo'), 'produced.go', ), 'package main\n');

  const refused = failed(await fx.dispatch(['demo', '--remove']).catch((error) => error));
  assert.equal(refused.code, 65);
  assert.match(refused.stderr, /uncommitted changes/);
  await fs.access(path.join(fx.tree('demo'), 'produced.go'));

  // Excluded orchestrator files are not "work" and must not trip the guard.
  await fs.rm(path.join(fx.tree('demo'), 'produced.go'));
  await fs.writeFile(path.join(fx.tree('demo'), 'NOTES.md'), 'handoff\n');
  await fs.writeFile(path.join(fx.tree('demo'), 'driver.log'), 'iteration 1\n');
  const { stdout } = await fx.dispatch(['demo', '--remove']);
  assert.match(stdout, /Removed/);
});
