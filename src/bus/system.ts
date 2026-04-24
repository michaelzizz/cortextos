import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { readdirSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';
import type { BusPaths } from '../types/index.js';

// --- Types ---

export interface AutoCommitReport {
  status: 'staged' | 'clean' | 'nothing_to_stage' | 'dry_run';
  staged: string[];
  blocked: string[];
  diff_stat?: string;
}

export interface AgentGoalStatus {
  agent: string;
  org: string;
  status: 'fresh' | 'stale' | 'missing' | 'no_timestamp' | 'parse_error';
  updated?: string;
  age_days?: number;
  stale: boolean;
  reason?: string;
}

export interface GoalStalenessReport {
  summary: { total: number; stale: number; fresh: number; threshold_days: number };
  agents: AgentGoalStatus[];
}

// --- Blocked file patterns ---

const BINARY_TEMP_EXTENSIONS = new Set([
  '.log', '.tmp', '.pid', '.pyc', '.pyo', '.class', '.o', '.so', '.dylib',
]);

const EXCLUDED_DIR_PREFIXES = [
  'telegram-images/',
  'node_modules/',
  '__pycache__/',
  '.venv/',
];

const CREDENTIAL_PATTERNS = /(?:token=|key=|password=|secret=|sk-|ghp_|xoxb-|AKIA)/;

const SCRIPT_EXTENSIONS = new Set(['.sh', '.py', '.js']);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Functions ---

/**
 * Plan a self-restart. Creates a marker file and logs the reason.
 * The daemon handles the actual restart via IPC.
 * Mirrors bash bus/self-restart.sh.
 */
export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create restart marker
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

// --- Pause/resume org ---

export interface PauseOrgReport {
  status: 'paused' | 'already_paused';
  paused_at: string;
  flag_path: string;
}

export interface ResumeOrgReport {
  status: 'resumed' | 'not_paused';
  paused_at?: string;
  resumed_at?: string;
  duration_seconds?: number;
  cron_prompts_dropped_count_estimate?: number;
  flag_path: string;
}

function orgFlagPath(ctxRoot: string, org: string): string {
  return join(ctxRoot, 'state', `${org}-paused`);
}

/**
 * Parse simple interval strings like "5m", "4h", "1d", "30s" into seconds.
 * Returns null for cron expressions or anything we can't recognise — those
 * are simply not counted in the best-effort drop estimate.
 */
function intervalToSeconds(interval: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(interval.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return null;
  }
}

/**
 * Best-effort estimate of how many cron firings would have landed during a
 * pause window. Walks every agent config under
 * `<frameworkRoot>/orgs/<org>/agents/<agent>/config.json`, counts recurring
 * crons whose `interval` parses, and floors duration / interval per cron.
 * Cron-expression crons (no simple interval) are skipped.
 */
function estimateDroppedCrons(
  frameworkRoot: string,
  org: string,
  durationSeconds: number,
): number {
  if (!frameworkRoot || durationSeconds <= 0) return 0;
  const agentsDir = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsDir)) return 0;

  let dropped = 0;
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return 0;
  }

  for (const agent of entries) {
    const configPath = join(agentsDir, agent, 'config.json');
    if (!existsSync(configPath)) continue;
    let config: any;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }
    const crons = Array.isArray(config.crons) ? config.crons : [];
    for (const cron of crons) {
      if (!cron || typeof cron !== 'object') continue;
      if (cron.type && cron.type !== 'recurring') continue;
      const interval = typeof cron.interval === 'string' ? cron.interval : '';
      const seconds = intervalToSeconds(interval);
      if (!seconds) continue;
      dropped += Math.floor(durationSeconds / seconds);
    }
  }
  return dropped;
}

/**
 * Pause an org. Writes an ISO-timestamp flag file at
 * `${ctxRoot}/state/<org>-paused`. Idempotent — a second call returns the
 * original paused_at without overwriting it.
 */
export function pauseOrg(ctxRoot: string, org: string): PauseOrgReport {
  const flagPath = orgFlagPath(ctxRoot, org);
  if (existsSync(flagPath)) {
    let pausedAt = '';
    try {
      pausedAt = readFileSync(flagPath, 'utf-8').trim();
    } catch { /* ignore */ }
    return { status: 'already_paused', paused_at: pausedAt, flag_path: flagPath };
  }
  const pausedAt = new Date().toISOString();
  ensureDir(join(ctxRoot, 'state'));
  writeFileSync(flagPath, pausedAt + '\n', 'utf-8');
  return { status: 'paused', paused_at: pausedAt, flag_path: flagPath };
}

/**
 * Resume an org. Removes the flag file, returns a report with approximate
 * dropped cron-firing count. Safe to call when not paused — returns
 * `status: 'not_paused'` without error.
 */
export function resumeOrg(
  ctxRoot: string,
  org: string,
  frameworkRoot: string = '',
): ResumeOrgReport {
  const flagPath = orgFlagPath(ctxRoot, org);
  if (!existsSync(flagPath)) {
    return { status: 'not_paused', flag_path: flagPath };
  }

  let pausedAt = '';
  try {
    pausedAt = readFileSync(flagPath, 'utf-8').trim();
  } catch { /* ignore */ }

  const resumedAt = new Date().toISOString();
  const pausedMs = Date.parse(pausedAt);
  const durationSeconds = Number.isFinite(pausedMs)
    ? Math.max(0, Math.floor((Date.parse(resumedAt) - pausedMs) / 1000))
    : 0;

  const dropped = estimateDroppedCrons(frameworkRoot, org, durationSeconds);

  try {
    unlinkSync(flagPath);
  } catch { /* ignore */ }

  return {
    status: 'resumed',
    paused_at: pausedAt,
    resumed_at: resumedAt,
    duration_seconds: durationSeconds,
    cron_prompts_dropped_count_estimate: dropped,
    flag_path: flagPath,
  };
}

/**
 * Plan a hard restart (fresh session, no --continue).
 * Creates .force-fresh marker file; daemon checks this on next restart.
 * Mirrors bash bus/hard-restart.sh.
 */
export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create force-fresh marker (agent-process.ts checks this on restart)
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.force-fresh'), resolvedReason + '\n', 'utf-8');

  // Also create restart marker so crash-alert knows it was planned
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Auto-commit safe files in a project directory.
 * Filters out dangerous files (credentials, env, large, binary).
 * Never pushes. Mirrors bash bus/auto-commit.sh.
 */
export function autoCommit(projectDir: string, dryRun: boolean = false): AutoCommitReport {
  // Check if git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, stdio: 'pipe' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  // Get changed files
  let porcelainOutput: string;
  try {
    porcelainOutput = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  if (!porcelainOutput.trim()) {
    return { status: 'clean', staged: [], blocked: [] };
  }

  const changedFiles = porcelainOutput
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.slice(3)); // cut from column 4 (0-indexed col 3)

  const staged: string[] = [];
  const blocked: string[] = [];

  for (const file of changedFiles) {
    if (!file) continue;

    // Block .env files
    if (file.endsWith('.env') || file.includes('/.env')) {
      blocked.push(`${file}:contains_credentials`);
      continue;
    }

    // Block .cortextos-env
    if (file === '.cortextos-env' || file.endsWith('/.cortextos-env')) {
      blocked.push(`${file}:runtime_env`);
      continue;
    }

    // Block binary/temp extensions
    const ext = extname(file);
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }

    // Block excluded directories
    if (EXCLUDED_DIR_PREFIXES.some(prefix => file.startsWith(prefix))) {
      blocked.push(`${file}:excluded_directory`);
      continue;
    }

    const fullPath = join(projectDir, file);

    // Block files over 10MB
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE) {
          blocked.push(`${file}:over_10MB`);
          continue;
        }
      } catch {
        // If can't stat, still try to stage
      }
    }

    // Check credential patterns in non-script file content
    if (existsSync(fullPath) && !SCRIPT_EXTENSIONS.has(ext)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const content = readFileSync(fullPath, 'utf-8');
          if (CREDENTIAL_PATTERNS.test(content)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
        // Binary files may throw on utf-8 read - skip credential check
      }
    }

    staged.push(file);
  }

  if (staged.length === 0) {
    return { status: 'nothing_to_stage', staged: [], blocked };
  }

  if (dryRun) {
    return { status: 'dry_run', staged, blocked };
  }

  // Stage safe files
  for (const file of staged) {
    try {
      execFileSync('git', ['add', file], { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // Ignore individual add failures
    }
  }

  // Get diff stat
  let diffStat: string | undefined;
  try {
    const stat = execSync('git diff --cached --stat', { cwd: projectDir, encoding: 'utf-8' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1]?.trim() || undefined;
  } catch {
    // Ignore
  }

  return { status: 'staged', staged, blocked, diff_stat: diffStat };
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 */
export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = Date.now();

  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) {
    return {
      summary: { total: 0, stale: 0, fresh: 0, threshold_days: thresholdDays },
      agents: [],
    };
  }

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsDir).filter(name => {
      try {
        return statSync(join(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    orgNames = [];
  }

  for (const orgName of orgNames) {
    const agentsDir = join(orgsDir, orgName, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentNames: string[];
    try {
      agentNames = readdirSync(agentsDir).filter(name => {
        // Validate agent name (lowercase, numbers, hyphens, underscores)
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        try {
          return statSync(join(agentsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const agentName of agentNames) {
      const goalsFile = join(agentsDir, agentName, 'GOALS.md');

      if (!existsSync(goalsFile)) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'no GOALS.md file',
        });
        continue;
      }

      // Read and parse GOALS.md
      let content: string;
      try {
        content = readFileSync(goalsFile, 'utf-8');
      } catch {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'could not read GOALS.md',
        });
        continue;
      }

      // Find "## Updated" section and get the next line
      const lines = content.split('\n');
      let updatedLine: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## Updated')) {
          // Get next non-empty line
          for (let j = i + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith('##')) {
              updatedLine = trimmed;
              break;
            }
          }
          break;
        }
      }

      if (!updatedLine) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'no_timestamp',
          stale: true,
          reason: 'no Updated timestamp in GOALS.md',
        });
        continue;
      }

      // Parse ISO 8601 timestamp
      const parsedDate = new Date(updatedLine);
      if (isNaN(parsedDate.getTime())) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'parse_error',
          updated: updatedLine,
          stale: true,
          reason: 'could not parse timestamp',
        });
        continue;
      }

      const ageMs = now - parsedDate.getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const isStale = ageMs > thresholdMs;

      agents.push({
        agent: agentName,
        org: orgName,
        status: isStale ? 'stale' : 'fresh',
        updated: updatedLine,
        age_days: ageDays,
        stale: isStale,
        reason: isStale
          ? `${ageDays} days since last update (threshold: ${thresholdDays})`
          : undefined,
      });
    }
  }

  const total = agents.length;
  const staleCount = agents.filter(a => a.stale).length;
  const freshCount = agents.filter(a => !a.stale).length;

  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays,
    },
    agents,
  };
}

/**
 * Post a message to the org's Telegram activity channel.
 *
 * Returns false if not configured (silent fail — callers can ignore the
 * return value and treat activity-channel posting as best-effort).
 *
 * `replyMarkup` is an optional Telegram inline keyboard (or any reply
 * markup shape). When provided, the message ships with the keyboard
 * attached — used for interactive workflows like approval Approve/Deny
 * buttons posted alongside approval creation. Leaving it undefined
 * preserves the prior one-way notification shape exactly.
 *
 * Mirrors bash bus/post-activity.sh.
 */
export async function postActivity(
  orgDir: string,
  ctxRoot: string,
  org: string,
  message: string,
  replyMarkup?: object,
): Promise<boolean> {
  // Look for activity-channel.env
  const candidates = [
    join(orgDir, 'activity-channel.env'),
    join(ctxRoot, 'orgs', org, 'activity-channel.env'),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return false;
  }

  // Parse the env file
  let botToken: string | undefined;
  let chatId: string | undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'ACTIVITY_BOT_TOKEN') botToken = value;
      if (key === 'ACTIVITY_CHAT_ID') chatId = value;
    }
  } catch {
    return false;
  }

  if (!botToken || !chatId) {
    return false;
  }

  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}
