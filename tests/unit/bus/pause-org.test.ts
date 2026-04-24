import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pauseOrg, resumeOrg } from '../../../src/bus/system';

describe('pauseOrg / resumeOrg', () => {
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-pause-org-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-pause-org-fw-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  describe('pauseOrg', () => {
    it('creates the flag file at ctxRoot/state/<org>-paused with an ISO timestamp', () => {
      const r = pauseOrg(ctxRoot, 'hq');
      expect(r.status).toBe('paused');
      expect(r.flag_path).toBe(join(ctxRoot, 'state', 'hq-paused'));
      expect(existsSync(r.flag_path)).toBe(true);
      expect(r.paused_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      const onDisk = readFileSync(r.flag_path, 'utf-8').trim();
      expect(onDisk).toBe(r.paused_at);
    });

    it('is idempotent: a second call returns already_paused and preserves the original timestamp', async () => {
      const first = pauseOrg(ctxRoot, 'hq');
      // Sleep 5ms so that if we DID overwrite, the timestamp would differ.
      await new Promise((res) => setTimeout(res, 5));
      const second = pauseOrg(ctxRoot, 'hq');
      expect(second.status).toBe('already_paused');
      expect(second.paused_at).toBe(first.paused_at);
      expect(readFileSync(first.flag_path, 'utf-8').trim()).toBe(first.paused_at);
    });
  });

  describe('resumeOrg', () => {
    it('removes the flag and returns duration_seconds + dropped estimate', () => {
      // Agent config with a 4h heartbeat cron.
      const agentDir = join(frameworkRoot, 'orgs', 'hq', 'agents', 'dev');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'config.json'),
        JSON.stringify({
          crons: [{ name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'hb' }],
        }),
      );

      // Pretend the org was paused 10 hours ago.
      const pausedAt = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      writeFileSync(join(ctxRoot, 'state', 'hq-paused'), pausedAt + '\n', 'utf-8');

      const r = resumeOrg(ctxRoot, 'hq', frameworkRoot);
      expect(r.status).toBe('resumed');
      expect(r.paused_at).toBe(pausedAt);
      expect(r.resumed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Duration should be ~10h = 36000s; allow a few seconds of test slippage.
      expect(r.duration_seconds!).toBeGreaterThanOrEqual(35990);
      expect(r.duration_seconds!).toBeLessThanOrEqual(36010);
      // 10h / 4h = 2 firings dropped.
      expect(r.cron_prompts_dropped_count_estimate).toBe(2);
      expect(existsSync(r.flag_path)).toBe(false);
    });

    it('returns not_paused without error when there is no flag', () => {
      const r = resumeOrg(ctxRoot, 'hq', frameworkRoot);
      expect(r.status).toBe('not_paused');
      expect(r.flag_path).toBe(join(ctxRoot, 'state', 'hq-paused'));
      expect(r.paused_at).toBeUndefined();
    });

    it('estimates zero dropped firings when frameworkRoot is missing or no agents exist', () => {
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      const pausedAt = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'state', 'hq-paused'), pausedAt + '\n', 'utf-8');

      const r = resumeOrg(ctxRoot, 'hq', frameworkRoot); // frameworkRoot has no orgs/hq/agents
      expect(r.status).toBe('resumed');
      expect(r.cron_prompts_dropped_count_estimate).toBe(0);
    });

    it('skips cron-expression crons (no simple interval) in the estimate', () => {
      const agentDir = join(frameworkRoot, 'orgs', 'hq', 'agents', 'dev');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'config.json'),
        JSON.stringify({
          crons: [
            { name: 'a', type: 'recurring', interval: '0 */4 * * *', prompt: 'a' },
            { name: 'b', type: 'recurring', interval: '1h', prompt: 'b' },
          ],
        }),
      );

      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      const pausedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'state', 'hq-paused'), pausedAt + '\n', 'utf-8');

      const r = resumeOrg(ctxRoot, 'hq', frameworkRoot);
      // Only the "1h" cron counts → 3 dropped firings. The cron-expression one is skipped.
      expect(r.cron_prompts_dropped_count_estimate).toBe(3);
    });
  });
});
