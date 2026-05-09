import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  syncUpstreamRolling,
  summarizeUpstreamCommits,
  findRollingPr,
  type Runner,
  type SyncEvent,
} from '../../../src/bus/sync-upstream-rolling';

/**
 * Tests for the rolling upstream-sync workflow.
 *
 * Real git repos in tmpdir for the merge / rev-list path (matches the
 * pattern in check-upstream.test.ts). The gh CLI surface (pr list / create
 * / edit) is mocked through the `runner` injection point so tests don't
 * touch GitHub.
 */

const GIT_AUTHOR = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

function setupRepoTrio(prefix: string): {
  fork: string;
  origin: string;
  upstream: string;
  cleanup: () => void;
} {
  // upstream: bare-ish repo that simulates grandamenium/cortextos
  const upstream = mkdtempSync(join(tmpdir(), `${prefix}-upstream-`));
  // origin: bare-ish repo that simulates the user's fork
  const origin = mkdtempSync(join(tmpdir(), `${prefix}-origin-`));
  // fork: the local working tree
  const fork = mkdtempSync(join(tmpdir(), `${prefix}-fork-`));

  // Init upstream with one commit on main
  execSync('git init -q -b main', { cwd: upstream, stdio: 'pipe', env: { ...process.env, ...GIT_AUTHOR } });
  execSync('git config user.email t@t', { cwd: upstream, stdio: 'pipe' });
  execSync('git config user.name T', { cwd: upstream, stdio: 'pipe' });
  writeFileSync(join(upstream, 'README'), 'v1\n');
  execSync('git add README && git commit -q -m "init"', { cwd: upstream, stdio: 'pipe', env: { ...process.env, ...GIT_AUTHOR } });

  // Origin starts as a clone of upstream (the fork was forked from upstream)
  execSync(`git clone -q "${upstream}" "${origin}"`, { stdio: 'pipe' });

  // Local working tree clones from origin and adds upstream as a remote
  execSync(`git clone -q "${origin}" "${fork}"`, { stdio: 'pipe' });
  execSync('git config user.email t@t', { cwd: fork, stdio: 'pipe' });
  execSync('git config user.name T', { cwd: fork, stdio: 'pipe' });
  execSync(`git remote add upstream "${upstream}"`, { cwd: fork, stdio: 'pipe' });
  execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

  return {
    fork,
    origin,
    upstream,
    cleanup: () => {
      rmSync(fork, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
      rmSync(upstream, { recursive: true, force: true });
    },
  };
}

function commit(repo: string, file: string, content: string, message: string) {
  writeFileSync(join(repo, file), content);
  execSync(`git add ${file} && git commit -q -m "${message}"`, {
    cwd: repo, stdio: 'pipe', env: { ...process.env, ...GIT_AUTHOR },
  });
}

/**
 * Build a runner that delegates real git/npm commands to execSync but
 * intercepts gh-CLI calls with a configurable script. The script returns
 * canned output for the next gh call, so tests can simulate "PR exists"
 * vs "PR does not exist" responses.
 */
function makeRunner(ghHandler: (cmd: string) => string): Runner {
  return (cmd, opts) => {
    if (cmd.startsWith('gh ')) {
      return ghHandler(cmd);
    }
    if (cmd.startsWith('npm ')) {
      // Tests skip build+test by default; if they slip through, no-op rather
      // than actually running npm against tmpdirs that have no package.json.
      return '';
    }
    return execSync(cmd, opts).toString();
  };
}

// ---------------------------------------------------------------------------
// summarizeUpstreamCommits
// ---------------------------------------------------------------------------

describe('summarizeUpstreamCommits', () => {
  it('groups conventional-commit subjects by type with feat first', () => {
    const out = summarizeUpstreamCommits([
      'feat(daemon): persistent crons',
      'fix(cron): double-fire on crash mid-fire',
      'feat(cli): import-agent',
      'docs(changelog): bump v0.2.0',
      'chore(deps): bump tsup',
    ]);
    const featIdx = out.indexOf('### Features');
    const fixIdx = out.indexOf('### Fixes');
    const docsIdx = out.indexOf('### Docs');
    const choreIdx = out.indexOf('### Chores');

    expect(featIdx).toBeGreaterThan(-1);
    expect(featIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(docsIdx);
    expect(docsIdx).toBeLessThan(choreIdx);

    expect(out).toContain('- daemon): persistent crons'.replace('daemon): ', ''));
    // Strips the "feat(daemon): " prefix so the bullet reads naturally.
    expect(out).toContain('- persistent crons');
    expect(out).toContain('- double-fire on crash mid-fire');
  });

  it('buckets non-conventional subjects into Other', () => {
    const out = summarizeUpstreamCommits([
      'Merge pull request #42',
      'feat: new thing',
      'plain commit subject',
    ]);
    expect(out).toContain('### Features');
    expect(out).toContain('- new thing');
    expect(out).toContain('### Other');
    expect(out).toContain('- Merge pull request #42');
    expect(out).toContain('- plain commit subject');
  });

  it('returns empty string for empty input', () => {
    expect(summarizeUpstreamCommits([])).toBe('');
    expect(summarizeUpstreamCommits(['', '   '])).toBe('');
  });

  it('handles conventional commit "!" breaking-change marker', () => {
    const out = summarizeUpstreamCommits(['feat(api)!: drop legacy v1 endpoints']);
    expect(out).toContain('### Features');
    expect(out).toContain('- drop legacy v1 endpoints');
  });
});

// ---------------------------------------------------------------------------
// findRollingPr — gh wrapper
// ---------------------------------------------------------------------------

describe('findRollingPr', () => {
  it('returns null when gh prints empty array', () => {
    const runner: Runner = () => '[]';
    expect(findRollingPr('owner/repo', 'feature/sync', runner, '/tmp')).toBeNull();
  });

  it('returns null when gh prints empty string', () => {
    const runner: Runner = () => '';
    expect(findRollingPr('owner/repo', 'feature/sync', runner, '/tmp')).toBeNull();
  });

  it('returns first match with number+url when gh returns a PR', () => {
    const runner: Runner = () => JSON.stringify([
      { number: 17, url: 'https://github.com/owner/repo/pull/17' },
    ]);
    const result = findRollingPr('owner/repo', 'feature/sync', runner, '/tmp');
    expect(result).toEqual({ number: 17, url: 'https://github.com/owner/repo/pull/17' });
  });

  it('returns null when gh throws (e.g. auth error)', () => {
    const runner: Runner = () => { throw new Error('not authenticated'); };
    expect(findRollingPr('owner/repo', 'feature/sync', runner, '/tmp')).toBeNull();
  });

  it('returns null when gh returns malformed JSON', () => {
    const runner: Runner = () => 'definitely not json';
    expect(findRollingPr('owner/repo', 'feature/sync', runner, '/tmp')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncUpstreamRolling — full workflow
// ---------------------------------------------------------------------------

describe('syncUpstreamRolling', () => {
  let fork: string;
  let origin: string;
  let upstream: string;
  let cleanup: () => void;

  beforeEach(() => {
    const r = setupRepoTrio('cortextos-sync');
    fork = r.fork;
    origin = r.origin;
    upstream = r.upstream;
    cleanup = r.cleanup;
  });

  afterEach(() => cleanup());

  it('returns no_changes silently when upstream has no new commits', async () => {
    const events: SyncEvent[] = [];
    const telegrams: string[] = [];
    const runner = makeRunner(() => '');

    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: true,
      notifyTelegram: async (m) => { telegrams.push(m); },
      logEvent: (e) => { events.push(e); },
    });

    expect(r.status).toBe('no_changes');
    expect(r.newCommits).toBe(0);
    expect(telegrams).toHaveLength(0); // silent on no-op
    expect(events.some((e) => e.name === 'sync_upstream_no_changes')).toBe(true);
  });

  it('opens a new PR when rolling branch does not yet exist', async () => {
    // Add a commit on upstream and refresh fork's view of it.
    commit(upstream, 'NEW.md', '# new\n', 'feat(daemon): add cool thing');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const ghCalls: string[] = [];
    const runner = makeRunner((cmd) => {
      ghCalls.push(cmd);
      if (cmd.startsWith('gh pr list')) return '[]';
      if (cmd.startsWith('gh pr create')) return 'https://github.com/owner/repo/pull/42\n';
      return '';
    });

    const events: SyncEvent[] = [];
    const telegrams: string[] = [];

    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: true,
      notifyTelegram: async (m) => { telegrams.push(m); },
      logEvent: (e) => { events.push(e); },
    });

    expect(r.status).toBe('pr_created');
    expect(r.newCommits).toBe(1);
    expect(r.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(r.prNumber).toBe(42);
    expect(r.summary).toContain('### Features');
    expect(r.summary).toContain('- add cool thing');
    expect(ghCalls.some((c) => c.includes('gh pr list'))).toBe(true);
    expect(ghCalls.some((c) => c.includes('gh pr create'))).toBe(true);
    expect(ghCalls.some((c) => c.includes('--repo owner/repo'))).toBe(true);
    expect(ghCalls.some((c) => c.includes('--base main'))).toBe(true);
    expect(telegrams).toHaveLength(1); // notify on new commits absorbed
    expect(telegrams[0]).toContain('https://github.com/owner/repo/pull/42');
    expect(events.some((e) => e.name === 'sync_upstream_pr_created')).toBe(true);
  });

  it('updates existing PR body when rolling branch already has an open PR', async () => {
    commit(upstream, 'A', 'a', 'fix(cron): double-fire');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const ghCalls: string[] = [];
    const runner = makeRunner((cmd) => {
      ghCalls.push(cmd);
      if (cmd.startsWith('gh pr list')) {
        return JSON.stringify([{ number: 99, url: 'https://github.com/owner/repo/pull/99' }]);
      }
      if (cmd.startsWith('gh pr edit')) return '';
      // gh pr create must not be called
      if (cmd.startsWith('gh pr create')) throw new Error('should not be called when PR exists');
      return '';
    });

    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: true,
    });

    expect(r.status).toBe('pr_updated');
    expect(r.prNumber).toBe(99);
    expect(r.prUrl).toBe('https://github.com/owner/repo/pull/99');
    expect(ghCalls.some((c) => c.startsWith('gh pr edit 99'))).toBe(true);
    expect(ghCalls.some((c) => c.startsWith('gh pr create'))).toBe(false);
  });

  it('returns merge_conflict and notifies when fork+upstream touched the same line', async () => {
    // Write the same file to both sides with different content — guaranteed conflict.
    commit(upstream, 'CLASH.md', 'upstream version\n', 'feat: upstream change');

    // Make origin (which fork tracks) also have a divergent change to the same file.
    // Easiest: commit on origin directly (origin is a normal clone here).
    commit(origin, 'CLASH.md', 'fork version\n', 'feat: fork change');

    // Refresh fork's view of both remotes.
    execSync('git fetch -q origin main', { cwd: fork, stdio: 'pipe' });
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });
    // Pull in the new origin/main commit into the local main so the rolling
    // branch (which we'll create from origin/main) carries the conflicting fork change.
    execSync('git merge --ff-only origin/main', { cwd: fork, stdio: 'pipe' });

    const ghCalls: string[] = [];
    const runner = makeRunner((cmd) => {
      ghCalls.push(cmd);
      throw new Error(`gh should not be called on conflict: ${cmd}`);
    });

    const events: SyncEvent[] = [];
    const telegrams: string[] = [];

    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: true,
      notifyTelegram: async (m) => { telegrams.push(m); },
      logEvent: (e) => { events.push(e); },
    });

    expect(r.status).toBe('merge_conflict');
    expect(r.newCommits).toBe(1);
    expect(r.conflictedFiles).toContain('CLASH.md');
    expect(ghCalls).toHaveLength(0); // gh never called when merge fails
    expect(telegrams).toHaveLength(1);
    expect(telegrams[0]).toMatch(/conflict/i);
    expect(events.some((e) => e.name === 'sync_upstream_conflict' && e.severity === 'error')).toBe(true);
  });

  it('returns build_failed and notifies when npm run build fails (skipBuildAndTest=false)', async () => {
    commit(upstream, 'X', 'x', 'feat: thing');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const events: SyncEvent[] = [];
    const telegrams: string[] = [];

    const runner: Runner = (cmd, opts) => {
      if (cmd === 'npm run build') {
        const e = new Error('tsc failed') as Error & { status: number };
        e.status = 1;
        throw e;
      }
      if (cmd.startsWith('gh ')) {
        throw new Error(`gh should not be called when build fails: ${cmd}`);
      }
      return execSync(cmd, opts).toString();
    };

    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: false,
      notifyTelegram: async (m) => { telegrams.push(m); },
      logEvent: (e) => { events.push(e); },
    });

    expect(r.status).toBe('build_failed');
    expect(r.newCommits).toBe(1);
    expect(telegrams).toHaveLength(1);
    expect(telegrams[0]).toMatch(/npm run build/);
    expect(events.some((e) => e.name === 'sync_upstream_build_failed' && e.severity === 'error')).toBe(true);
  });

  it('returns test_failed and notifies when npm test fails after build succeeds', async () => {
    commit(upstream, 'Y', 'y', 'fix: bug');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const runner: Runner = (cmd, opts) => {
      if (cmd === 'npm run build') return ''; // build OK
      if (cmd === 'npm test') {
        const e = new Error('vitest failures') as Error & { status: number };
        e.status = 1;
        throw e;
      }
      if (cmd.startsWith('gh ')) {
        throw new Error(`gh should not be called when tests fail: ${cmd}`);
      }
      return execSync(cmd, opts).toString();
    };

    const telegrams: string[] = [];
    const r = await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: false,
      notifyTelegram: async (m) => { telegrams.push(m); },
    });

    expect(r.status).toBe('test_failed');
    expect(telegrams).toHaveLength(1);
    expect(telegrams[0]).toMatch(/npm test/);
  });

  it('still pushes to origin (never touches upstream) on success', async () => {
    commit(upstream, 'Z', 'z', 'feat: another thing');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const seen: string[] = [];
    const runner: Runner = (cmd, opts) => {
      seen.push(cmd);
      if (cmd.startsWith('gh pr list')) return '[]';
      if (cmd.startsWith('gh pr create')) return 'https://github.com/owner/repo/pull/1\n';
      if (cmd.startsWith('npm ')) return '';
      return execSync(cmd, opts).toString();
    };

    await syncUpstreamRolling({
      cwd: fork,
      forkRepo: 'owner/repo',
      runner,
      skipBuildAndTest: true,
    });

    // Must push to origin, never to upstream.
    expect(seen.some((c) => c.startsWith('git push --set-upstream origin'))).toBe(true);
    expect(seen.some((c) => /git push.*upstream/.test(c) && !c.includes('origin'))).toBe(false);
  });
});
