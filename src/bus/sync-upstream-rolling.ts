/**
 * Rolling upstream-sync workflow.
 *
 * Drives the same workflow a human runs by hand — fetch upstream, merge into
 * a long-lived rolling branch, build, test, push, find-or-create a PR — but
 * exits silently on weeks where upstream produced no commits, and only
 * surfaces a Telegram message when something needs human attention
 * (conflict, build/test failure) or new commits were absorbed.
 *
 * Wired up as `cortextos bus sync-upstream-rolling`. Designed to be invoked
 * weekly by an orchestrator cron.
 */

import { execSync } from 'child_process';
import type { ExecSyncOptions } from 'child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncStatus =
  | 'no_changes'
  | 'merge_conflict'
  | 'build_failed'
  | 'test_failed'
  | 'push_failed'
  | 'pr_created'
  | 'pr_updated'
  | 'error';

export interface SyncResult {
  status: SyncStatus;
  newCommits: number;
  branch: string;
  prUrl?: string;
  prNumber?: number;
  conflictedFiles?: string[];
  /** Plain-English summary of upstream commits, also used as the PR body. */
  summary?: string;
  /** Human-readable status line — used for Telegram + log messages. */
  message?: string;
}

export interface SyncEvent {
  category: 'action' | 'error';
  name: string;
  severity: 'info' | 'warning' | 'error';
  meta: Record<string, unknown>;
}

export type Runner = (cmd: string, opts: ExecSyncOptions) => string;

export interface SyncUpstreamOptions {
  /** Working directory of the fork repo. Defaults to process.cwd(). */
  cwd?: string;
  /** Fork slug on GitHub, e.g. "michaelzizz/cortextos". Required for push + PR. */
  forkRepo: string;
  /** Rolling branch name. Default: feature/sync-upstream-rolling. */
  branch?: string;
  /** Skip `npm run build` + `npm test` (used in unit tests). */
  skipBuildAndTest?: boolean;
  /** Override exec runner. Tests inject a mock; production uses execSync. */
  runner?: Runner;
  /** Telegram notifier. Called on conflict / failure / new-commits-absorbed. */
  notifyTelegram?: (message: string) => void | Promise<void>;
  /** Optional event sink for structured logging. */
  logEvent?: (event: SyncEvent) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Group conventional-commit subjects by type and render a plain-English
 * markdown summary. Used both for the Telegram notification and the PR body
 * so the user reads the same thing in both places.
 *
 * Subjects without a recognised prefix are bucketed under "Other".
 */
export function summarizeUpstreamCommits(subjects: string[]): string {
  const order: Array<[string, string]> = [
    ['feat', 'Features'],
    ['fix', 'Fixes'],
    ['refactor', 'Refactors'],
    ['perf', 'Performance'],
    ['docs', 'Docs'],
    ['test', 'Tests'],
    ['chore', 'Chores'],
    ['other', 'Other'],
  ];
  const groups: Record<string, string[]> = Object.fromEntries(order.map(([k]) => [k, []]));

  for (const raw of subjects) {
    const subject = raw.trim();
    if (!subject) continue;
    const m = /^(feat|fix|refactor|perf|docs|test|chore)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject);
    if (m) {
      groups[m[1].toLowerCase()].push(m[2]);
    } else {
      groups.other.push(subject);
    }
  }

  const sections: string[] = [];
  for (const [key, heading] of order) {
    const items = groups[key];
    if (!items.length) continue;
    sections.push(`### ${heading}\n${items.map((s) => `- ${s}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

/**
 * Locate an open rolling-sync PR for the given fork+branch via `gh pr list`.
 * Returns the first match (we assume one rolling branch = one open PR at a time).
 */
export function findRollingPr(
  forkRepo: string,
  branch: string,
  runner: Runner,
  cwd: string,
): { number: number; url: string } | null {
  let raw: string;
  try {
    raw = runner(
      `gh pr list --repo ${forkRepo} --head ${branch} --state open --json number,url`,
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
  } catch {
    return null;
  }
  try {
    const arr = JSON.parse(raw || '[]');
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0].number === 'number') {
      return { number: arr[0].number, url: String(arr[0].url ?? '') };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run one tick of the rolling upstream-sync workflow.
 *
 * Steps:
 *   1. fetch upstream
 *   2. count new commits via `git rev-list --count origin/main..upstream/main`
 *      (rev-list, not diff-stat — diff-stat lies for forks ahead of upstream)
 *   3. if 0 new commits → return `no_changes` silently
 *   4. checkout (or create) the rolling branch
 *   5. merge upstream/main; on conflict: leave branch as-is, notify, return
 *   6. on clean merge: run npm build + test; on failure, notify, return
 *   7. push branch
 *   8. find-or-create PR; update body either way with fresh summary
 *   9. notify Telegram (only on new-commits-absorbed runs)
 */
export async function syncUpstreamRolling(
  opts: SyncUpstreamOptions,
): Promise<SyncResult> {
  const cwd = opts.cwd ?? process.cwd();
  const branch = opts.branch ?? 'feature/sync-upstream-rolling';
  const runner: Runner = opts.runner ?? ((cmd, o) => execSync(cmd, o).toString());
  const exec = (cmd: string, extra: ExecSyncOptions = {}): string =>
    runner(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe', ...extra });
  const notify = async (msg: string) => {
    if (opts.notifyTelegram) await opts.notifyTelegram(msg);
  };
  const log = (e: SyncEvent) => {
    if (opts.logEvent) opts.logEvent(e);
  };

  // Step 1: fetch upstream
  try {
    exec('git fetch upstream main');
  } catch (err) {
    const message = `Failed to fetch upstream: ${(err as Error).message}`;
    log({ category: 'error', name: 'sync_upstream_fetch_failed', severity: 'error', meta: { error: String(err) } });
    return { status: 'error', newCommits: 0, branch, message };
  }

  // Step 2: count new commits via rev-list (correct for forks ahead of upstream)
  let newCommits = 0;
  try {
    newCommits = parseInt(
      exec('git rev-list --count origin/main..upstream/main').trim(),
      10,
    );
    if (Number.isNaN(newCommits)) newCommits = 0;
  } catch {
    /* default 0 */
  }

  // Step 3: silent exit on no-op weeks
  if (newCommits === 0) {
    log({ category: 'action', name: 'sync_upstream_no_changes', severity: 'info', meta: {} });
    return { status: 'no_changes', newCommits: 0, branch, message: 'No upstream changes' };
  }

  // Step 4: enter the rolling branch (create if missing on origin)
  let branchExistsRemote = false;
  try {
    const out = exec(`git ls-remote --heads origin ${branch}`).trim();
    branchExistsRemote = out.length > 0;
  } catch {
    branchExistsRemote = false;
  }

  try {
    if (branchExistsRemote) {
      exec(`git fetch origin ${branch}`);
      // -B resets the branch to origin's tip if it already existed locally
      exec(`git checkout -B ${branch} origin/${branch}`);
    } else {
      exec(`git checkout -B ${branch} origin/main`);
    }
  } catch (err) {
    const message = `Failed to enter rolling branch ${branch}: ${(err as Error).message}`;
    log({ category: 'error', name: 'sync_upstream_checkout_failed', severity: 'error', meta: { error: String(err) } });
    return { status: 'error', newCommits, branch, message };
  }

  // Build the summary BEFORE merging — we want subjects of commits that are
  // about to be absorbed (origin/main..upstream/main), not subjects that
  // include any merge commit we are about to create.
  let commitSubjects: string[] = [];
  try {
    const raw = exec('git log origin/main..upstream/main --pretty=%s --no-merges');
    commitSubjects = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    /* leave empty */
  }
  const summary = summarizeUpstreamCommits(commitSubjects);

  // Step 5: merge upstream/main
  try {
    exec('git merge upstream/main --no-edit -m "Merge upstream main into rolling sync branch"');
  } catch {
    // Conflict — collect file list, leave branch in-flight for human resolution.
    let conflicted: string[] = [];
    try {
      conflicted = exec('git diff --name-only --diff-filter=U')
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      /* ignore */
    }
    const message = `Upstream sync hit ${conflicted.length} merge conflict(s) on ${branch}: ${conflicted.slice(0, 5).join(', ')}${conflicted.length > 5 ? ', …' : ''}. ${newCommits} upstream commit(s) waiting. Resolve manually then push.`;
    log({ category: 'error', name: 'sync_upstream_conflict', severity: 'error', meta: { branch, conflicted, newCommits } });
    await notify(message);
    return { status: 'merge_conflict', newCommits, branch, conflictedFiles: conflicted, summary, message };
  }

  // Step 6: build + test (skipped only by tests)
  if (!opts.skipBuildAndTest) {
    try {
      exec('npm run build', { stdio: 'pipe' });
    } catch (err) {
      const message = `Upstream sync: \`npm run build\` failed on ${branch} after merging ${newCommits} commit(s). Branch left in place for inspection.`;
      log({ category: 'error', name: 'sync_upstream_build_failed', severity: 'error', meta: { branch, newCommits, error: String(err) } });
      await notify(message);
      return { status: 'build_failed', newCommits, branch, summary, message };
    }
    try {
      exec('npm test', { stdio: 'pipe' });
    } catch (err) {
      const message = `Upstream sync: \`npm test\` failed on ${branch} after merging ${newCommits} commit(s). Branch left in place for inspection.`;
      log({ category: 'error', name: 'sync_upstream_test_failed', severity: 'error', meta: { branch, newCommits, error: String(err) } });
      await notify(message);
      return { status: 'test_failed', newCommits, branch, summary, message };
    }
  }

  // Step 7: push branch to origin (the fork — never to upstream)
  try {
    exec(`git push --set-upstream origin ${branch}`);
  } catch (err) {
    const message = `Upstream sync: failed to push ${branch} to origin: ${(err as Error).message}`;
    log({ category: 'error', name: 'sync_upstream_push_failed', severity: 'error', meta: { branch, error: String(err) } });
    await notify(message);
    return { status: 'push_failed', newCommits, branch, summary, message };
  }

  // Step 8: find-or-create PR
  const prTitle = 'chore: sync upstream main';
  const prBody = renderPrBody(newCommits, summary);

  const existing = findRollingPr(opts.forkRepo, branch, runner, cwd);
  let prUrl: string;
  let prNumber: number;
  let createdNew = false;

  if (existing) {
    prNumber = existing.number;
    prUrl = existing.url;
    try {
      exec(
        `gh pr edit ${existing.number} --repo ${opts.forkRepo} --body-file -`,
        { input: prBody, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      const message = `Upstream sync: pushed ${branch} but failed to update PR #${existing.number} body: ${(err as Error).message}`;
      log({ category: 'error', name: 'sync_upstream_pr_update_failed', severity: 'error', meta: { branch, prNumber: existing.number, error: String(err) } });
      await notify(message);
      return { status: 'error', newCommits, branch, prUrl, prNumber, summary, message };
    }
  } else {
    let raw: string;
    try {
      raw = exec(
        `gh pr create --repo ${opts.forkRepo} --base main --head ${branch} --title ${shellQuote(prTitle)} --body-file -`,
        { input: prBody, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
    } catch (err) {
      const message = `Upstream sync: pushed ${branch} but failed to open PR: ${(err as Error).message}`;
      log({ category: 'error', name: 'sync_upstream_pr_create_failed', severity: 'error', meta: { branch, error: String(err) } });
      await notify(message);
      return { status: 'error', newCommits, branch, summary, message };
    }
    prUrl = raw;
    const numMatch = /\/pull\/(\d+)/.exec(prUrl);
    prNumber = numMatch ? parseInt(numMatch[1], 10) : 0;
    createdNew = true;
  }

  // Step 9: success notification — only on new-commits-absorbed runs
  const verb = createdNew ? 'opened' : 'updated';
  const message = `Upstream sync ${verb} PR ${prUrl} — ${newCommits} new commit(s) on ${branch}.`;
  log({
    category: 'action',
    name: createdNew ? 'sync_upstream_pr_created' : 'sync_upstream_pr_updated',
    severity: 'info',
    meta: { branch, newCommits, prUrl, prNumber },
  });
  await notify(message);
  return {
    status: createdNew ? 'pr_created' : 'pr_updated',
    newCommits,
    branch,
    prUrl,
    prNumber,
    summary,
    message,
  };
}

function renderPrBody(newCommits: number, summary: string): string {
  const heading = `## Summary\n\nRolling auto-sync of \`michaelzizz/cortextos\` from \`grandamenium/cortextos@main\`. ${newCommits} new upstream commit(s) absorbed since the last update of this PR.`;
  const body = summary || '_No conventional-commit subjects detected — see commit log on the branch._';
  const footer = '\n\n---\n_Opened by `cortextos bus sync-upstream-rolling`. Do not merge until you have skimmed the upstream changes._';
  return `${heading}\n\n${body}${footer}`;
}

/**
 * Quote a string for safe inclusion as a single shell arg. Used only for the
 * PR title (a fixed, internal string today, but kept defensive in case a
 * caller ever overrides it).
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
