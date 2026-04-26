import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { checkUpstream } from '../../../src/bus/metrics';

/**
 * Set up two repos: an "upstream" bare-ish repo and a "fork" that has the
 * upstream wired as a remote called `upstream`. Returns the fork path.
 */
function setupRepoPair(prefix: string): { fork: string; upstream: string; cleanup: () => void } {
  const upstream = mkdtempSync(join(tmpdir(), `${prefix}-upstream-`));
  const fork = mkdtempSync(join(tmpdir(), `${prefix}-fork-`));

  const env = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };

  // upstream repo with one commit on `main`
  execSync('git init -q -b main', { cwd: upstream, stdio: 'pipe', env: { ...process.env, ...env } });
  execSync('git config user.email t@t', { cwd: upstream, stdio: 'pipe' });
  execSync('git config user.name T', { cwd: upstream, stdio: 'pipe' });
  writeFileSync(join(upstream, 'README'), 'v1');
  execSync('git add README && git commit -q -m "init"', { cwd: upstream, stdio: 'pipe', env: { ...process.env, ...env } });

  // fork: clone upstream and add it as `upstream` remote
  execSync(`git clone -q "${upstream}" "${fork}"`, { stdio: 'pipe' });
  execSync('git config user.email t@t', { cwd: fork, stdio: 'pipe' });
  execSync('git config user.name T', { cwd: fork, stdio: 'pipe' });
  execSync(`git remote add upstream "${upstream}"`, { cwd: fork, stdio: 'pipe' });
  execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

  return {
    fork,
    upstream,
    cleanup: () => {
      rmSync(fork, { recursive: true, force: true });
      rmSync(upstream, { recursive: true, force: true });
    },
  };
}

function commitOn(repo: string, file: string, content: string, message: string) {
  writeFileSync(join(repo, file), content);
  execSync(`git add ${file} && git commit -q -m "${message}"`, {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

describe('checkUpstream — gating on commits behind/ahead', () => {
  let fork: string;
  let upstream: string;
  let cleanup: () => void;

  beforeEach(() => {
    const r = setupRepoPair('cortextos-check-upstream');
    fork = r.fork;
    upstream = r.upstream;
    cleanup = r.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('returns up_to_date when fork and upstream are at the same commit', () => {
    const r = checkUpstream(fork);
    expect(r.status).toBe('up_to_date');
  });

  it('returns updates_available when upstream is ahead and local has no extra commits (clean fast-forward)', () => {
    commitOn(upstream, 'NEW', 'x', 'upstream-only');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const r = checkUpstream(fork);
    expect(r.status).toBe('updates_available');
    expect(r.commits).toBe(1);
    expect(r.diverged).toBeUndefined();
    expect(r.commits_ahead).toBeUndefined();
  });

  it('returns local_ahead (NOT updates_available) when fork is strictly ahead of upstream', () => {
    commitOn(fork, 'LOCAL', 'y', 'fork-only');

    const r = checkUpstream(fork);
    expect(r.status).toBe('local_ahead');
    expect(r.commits_ahead).toBe(1);
    expect(r.commits).toBeUndefined();
    expect(r.diff_stat).toBeUndefined();
    expect(r.message).toMatch(/ahead.*upstream/i);
  });

  it('flags divergence on updates_available when fork has its own commits AND upstream has new ones', () => {
    commitOn(fork, 'LOCAL', 'y', 'fork-only');
    commitOn(upstream, 'NEW', 'x', 'upstream-only');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const r = checkUpstream(fork);
    expect(r.status).toBe('updates_available');
    expect(r.commits).toBe(1);
    expect(r.commits_ahead).toBe(1);
    expect(r.diverged).toBe(true);
  });

  it('--apply refuses when local is ahead-only (no upstream commits to merge)', () => {
    commitOn(fork, 'LOCAL', 'y', 'fork-only');

    const r = checkUpstream(fork, { apply: true });
    expect(r.status).toBe('error');
    expect(r.commits_ahead).toBe(1);
    expect(r.error).toMatch(/refusing.*ahead/i);
    expect(r.error).toMatch(/no-?op|push.*upstream/i);
  });

  it('--apply refuses when history has diverged, regardless of CORTEXTOS_CONFIRM_UPSTREAM_MERGE', () => {
    commitOn(fork, 'LOCAL', 'y', 'fork-only');
    commitOn(upstream, 'NEW', 'x', 'upstream-only');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const prev = process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
    process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = 'yes';
    try {
      const r = checkUpstream(fork, { apply: true });
      expect(r.status).toBe('error');
      expect(r.diverged).toBe(true);
      expect(r.commits_ahead).toBe(1);
      expect(r.commits).toBe(1);
      expect(r.error).toMatch(/diverged/i);
    } finally {
      if (prev === undefined) delete process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
      else process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = prev;
    }
  });

  it('--apply still requires CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes for a clean fast-forward', () => {
    commitOn(upstream, 'NEW', 'x', 'upstream-only');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const prev = process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
    delete process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
    try {
      const r = checkUpstream(fork, { apply: true });
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/CORTEXTOS_CONFIRM_UPSTREAM_MERGE/);
    } finally {
      if (prev !== undefined) process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = prev;
    }
  });

  it('--apply succeeds for a clean fast-forward when env var is set', () => {
    commitOn(upstream, 'NEW', 'x', 'upstream-only');
    execSync('git fetch -q upstream main', { cwd: fork, stdio: 'pipe' });

    const prev = process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
    process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = 'yes';
    try {
      const r = checkUpstream(fork, { apply: true });
      expect(r.status).toBe('merged');
      expect(r.commits).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
      else process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = prev;
    }
  });

  it('returns error when no upstream remote is configured', () => {
    execSync('git remote remove upstream', { cwd: fork, stdio: 'pipe' });
    const r = checkUpstream(fork);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/upstream remote/i);
  });

  it('returns error when not a git repository', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortextos-not-a-git-repo-'));
    try {
      const r = checkUpstream(tmp);
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/not a git repository/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
