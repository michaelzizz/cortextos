import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decidePauseCheck } from '../../../src/hooks/hook-pause-check';

describe('decidePauseCheck', () => {
  let testDir: string;
  let flagPath: string;
  let configPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-pause-hook-'));
    flagPath = join(testDir, 'hq-paused');
    configPath = join(testDir, 'config.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('allows the prompt when the pause flag is absent', () => {
    writeFileSync(configPath, JSON.stringify({ crons: [{ prompt: 'hb' }] }));
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'hb' });
    expect(r).toEqual({ block: false });
  });

  it('allows the prompt when paused but prompt does not match any cron', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({ crons: [{ prompt: 'heartbeat' }] }));
    const r = decidePauseCheck({ flagPath, configPath, prompt: '=== TELEGRAM from Michael (chat_id:1)\nhey' });
    expect(r.block).toBe(false);
  });

  it('blocks the prompt when paused and prompt exactly matches a cron prompt', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'heartbeat', interval: '4h', prompt: 'Read HEARTBEAT.md and do the thing.' },
        { name: 'other', interval: '1h', prompt: 'Another cron' },
      ],
    }));
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'Read HEARTBEAT.md and do the thing.' });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/paused/i);
  });

  it('does not block when the cron prompt is a near-miss (trailing whitespace, different casing)', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({ crons: [{ prompt: 'exact-match-only' }] }));
    expect(decidePauseCheck({ flagPath, configPath, prompt: 'exact-match-only ' }).block).toBe(false);
    expect(decidePauseCheck({ flagPath, configPath, prompt: 'Exact-Match-Only' }).block).toBe(false);
    expect(decidePauseCheck({ flagPath, configPath, prompt: 'exact-match-only\n' }).block).toBe(false);
  });

  it('fails open (allows) when the config file is missing', () => {
    writeFileSync(flagPath, new Date().toISOString());
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'anything' });
    expect(r.block).toBe(false);
  });

  it('fails open (allows) when the config is malformed JSON', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, '{ not: valid');
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'anything' });
    expect(r.block).toBe(false);
  });

  it('allows when config has no crons array', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({ agent_name: 'dev' }));
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'anything' });
    expect(r.block).toBe(false);
  });

  it('allows when the crons array is empty', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({ crons: [] }));
    const r = decidePauseCheck({ flagPath, configPath, prompt: 'anything' });
    expect(r.block).toBe(false);
  });

  it('ignores cron entries with non-string prompts', () => {
    writeFileSync(flagPath, new Date().toISOString());
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { prompt: null },
        { prompt: 123 },
        { prompt: 'real-cron-prompt' },
      ],
    }));
    expect(decidePauseCheck({ flagPath, configPath, prompt: 'real-cron-prompt' }).block).toBe(true);
    expect(decidePauseCheck({ flagPath, configPath, prompt: '' }).block).toBe(false);
  });
});
