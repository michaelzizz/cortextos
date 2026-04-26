/**
 * UserPromptSubmit hook: two responsibilities, both keyed on whether the
 * incoming prompt exact-matches one of this agent's `config.crons[].prompt`
 * strings.
 *
 * 1. Cron-fire bookkeeping (always)
 *    On every match — paused or not — write a fresh `last_fire` to
 *    cron-state.json. The daemon's gap detector reads that file; before this
 *    hook recorded fires, the file never existed for any agent and the
 *    detector emitted infinite-gap nudges every ~10 minutes (issue:
 *    cron-gap-detector false positives).
 *
 * 2. Pause gating (only when the org-pause flag is present)
 *    When `${CTX_ROOT}/state/${CTX_ORG}-paused` exists, block matching cron
 *    prompts. Telegram messages, agent-to-agent messages, and user typing
 *    pass through untouched — only prompts that exactly equal a cron we
 *    configured ourselves are blocked. False positives (blocking a real
 *    user message) are much worse than false negatives (letting one cron
 *    through), which is why we never use a heuristic match.
 *
 * Failure mode: fails open. Missing env, unreadable config, broken stdin —
 * all allow. A misconfigured pause silently degrades rather than freezing
 * the agent.
 *
 * Exit codes per Claude Code hook protocol:
 *   0  → allow (stdout may add context; we add none)
 *   2  → block, stderr shown to the user as the reason
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { updateCronFire } from '../bus/cron-state.js';

export interface DecideInput {
  flagPath: string;
  configPath: string;
  prompt: string;
}

export interface DecideOutput {
  block: boolean;
  reason?: string;
}

export interface CronMatch {
  name?: string;
  interval?: string;
}

/**
 * Look up which cron in `config.crons` the given prompt exact-matches.
 * Returns null when no config exists, the file is malformed, or no entry
 * matches. Pure: never touches state.
 *
 * `name` and `interval` are optional on the returned object — match is on
 * `prompt` alone, so a config entry without a `name` still matches for
 * pause-check purposes; recording just skips it.
 */
export function findMatchingCron(configPath: string, prompt: string): CronMatch | null {
  if (!existsSync(configPath)) return null;
  let crons: any[];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    crons = Array.isArray(config.crons) ? config.crons : [];
  } catch {
    return null;
  }
  for (const c of crons) {
    if (c && typeof c.prompt === 'string' && c.prompt.length > 0 && c.prompt === prompt) {
      const name = typeof c.name === 'string' && c.name.length > 0 ? c.name : undefined;
      const interval = typeof c.interval === 'string' && c.interval.length > 0 ? c.interval : undefined;
      return { name, interval };
    }
  }
  return null;
}

/**
 * If the prompt is a cron prompt for this agent AND the entry has a name,
 * write a fresh fire record. Skips entries without a `name` (we need it as
 * the cron-state.json key). No-ops on any error so a broken cron-state.json
 * never breaks the hook. Returns the matched cron (for logging/tests) or null.
 */
export function recordCronFireIfMatch(
  configPath: string,
  prompt: string,
  stateDir: string,
): CronMatch | null {
  const match = findMatchingCron(configPath, prompt);
  if (!match || !match.name) return null;
  try {
    updateCronFire(stateDir, match.name, match.interval);
  } catch {
    /* ignore — fail open */
  }
  return match;
}

export function decidePauseCheck(input: DecideInput): DecideOutput {
  if (!existsSync(input.flagPath)) return { block: false };
  const match = findMatchingCron(input.configPath, input.prompt);
  if (!match) return { block: false };
  return { block: true, reason: 'blocked: org paused' };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const org = process.env.CTX_ORG;
  const agentName = process.env.CTX_AGENT_NAME;
  const frameworkRoot =
    process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  const ctxRoot =
    process.env.CTX_ROOT ||
    join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');

  if (!org || !agentName || !frameworkRoot) process.exit(0);

  const flagPath = join(ctxRoot, 'state', `${org}-paused`);
  const configPath = join(frameworkRoot, 'orgs', org, 'agents', agentName, 'config.json');
  const stateDir = join(ctxRoot, 'state', agentName);

  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }

  let prompt = '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
  } catch {
    process.exit(0);
  }

  // Always record cron fires when matched, regardless of pause state.
  // The harness scheduled the fire; whether we let it through is a separate
  // concern handled by the pause check below.
  recordCronFireIfMatch(configPath, prompt, stateDir);

  const decision = decidePauseCheck({ flagPath, configPath, prompt });
  if (decision.block) {
    process.stderr.write((decision.reason || 'blocked') + '\n');
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
