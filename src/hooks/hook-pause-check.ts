/**
 * UserPromptSubmit hook: blocks cron-driven prompts while the org is paused.
 *
 * Design:
 *   - Flag file at `${CTX_ROOT}/state/${CTX_ORG}-paused` gates the check.
 *   - When the flag is present, we load the agent's own config.json and
 *     compare the incoming prompt against `config.crons[].prompt` by EXACT
 *     string match. False positives (blocking a real user message) are much
 *     worse than false negatives (letting one cron through), so we only
 *     block on prompts that precisely match a cron we configured ourselves.
 *   - Everything that isn't a cron — Telegram messages, agent-to-agent
 *     messages, system prompts, user typing — passes through untouched.
 *   - Fails open: if env vars are missing, the flag can't be stat'd, or the
 *     config can't be parsed, we allow the prompt. A misconfigured pause
 *     silently degrades rather than freezing the agent.
 *
 * Exit codes per Claude Code hook protocol:
 *   0  → allow (stdout may add context; we add none)
 *   2  → block, stderr shown to the user as the reason
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface DecideInput {
  flagPath: string;
  configPath: string;
  prompt: string;
}

export interface DecideOutput {
  block: boolean;
  reason?: string;
}

export function decidePauseCheck(input: DecideInput): DecideOutput {
  if (!existsSync(input.flagPath)) return { block: false };
  if (!existsSync(input.configPath)) return { block: false };

  let cronPrompts: string[];
  try {
    const config = JSON.parse(readFileSync(input.configPath, 'utf-8'));
    const crons = Array.isArray(config.crons) ? config.crons : [];
    cronPrompts = crons
      .map((c: any) => c?.prompt)
      .filter((p: any): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return { block: false };
  }

  if (cronPrompts.length === 0) return { block: false };
  if (cronPrompts.includes(input.prompt)) {
    return { block: true, reason: 'blocked: org paused' };
  }
  return { block: false };
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

  if (!existsSync(flagPath)) process.exit(0);

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
