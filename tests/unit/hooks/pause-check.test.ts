import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  decidePauseCheck,
  findMatchingCron,
  recordCronFireIfMatch,
} from '../../../src/hooks/hook-pause-check';
import { readCronState } from '../../../src/bus/cron-state';

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

describe('findMatchingCron', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-find-cron-'));
    configPath = join(testDir, 'config.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns the matched cron name and interval on exact prompt match', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'heartbeat', interval: '4h', prompt: 'HB' },
        { name: 'inbox', interval: '1h', prompt: 'INBOX' },
      ],
    }));
    expect(findMatchingCron(configPath, 'HB')).toEqual({ name: 'heartbeat', interval: '4h' });
    expect(findMatchingCron(configPath, 'INBOX')).toEqual({ name: 'inbox', interval: '1h' });
  });

  it('returns null when prompt matches no cron', () => {
    writeFileSync(configPath, JSON.stringify({ crons: [{ name: 'hb', prompt: 'HB' }] }));
    expect(findMatchingCron(configPath, 'something else')).toBeNull();
  });

  it('returns null when config file is missing', () => {
    expect(findMatchingCron(configPath, 'anything')).toBeNull();
  });

  it('returns null when config is malformed', () => {
    writeFileSync(configPath, '{ not valid');
    expect(findMatchingCron(configPath, 'anything')).toBeNull();
  });

  it('returns name=undefined for matched entries with no name field (still useful for pause-check)', () => {
    writeFileSync(configPath, JSON.stringify({ crons: [{ prompt: 'unnamed-cron' }] }));
    expect(findMatchingCron(configPath, 'unnamed-cron')).toEqual({ name: undefined, interval: undefined });
  });

  it('only matches on exact equality, not on whitespace or casing variants', () => {
    writeFileSync(configPath, JSON.stringify({ crons: [{ name: 'a', prompt: 'EXACT' }] }));
    expect(findMatchingCron(configPath, 'EXACT ')).toBeNull();
    expect(findMatchingCron(configPath, 'exact')).toBeNull();
    expect(findMatchingCron(configPath, 'EXACT\n')).toBeNull();
  });

  it('skips entries with non-string prompts', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [
        { name: 'a', prompt: null },
        { name: 'b', prompt: 123 },
        { name: 'c', interval: '6h', prompt: 'real' },
      ],
    }));
    expect(findMatchingCron(configPath, 'real')).toEqual({ name: 'c', interval: '6h' });
  });
});

describe('recordCronFireIfMatch', () => {
  let testDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-record-fire-'));
    stateDir = join(testDir, 'state-dev');
    configPath = join(testDir, 'config.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a fresh last_fire to cron-state.json on a matched cron prompt', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'HB-PROMPT' }],
    }));

    const before = Date.now();
    const match = recordCronFireIfMatch(configPath, 'HB-PROMPT', stateDir);
    const after = Date.now();

    expect(match).toEqual({ name: 'heartbeat', interval: '4h' });
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(true);

    const state = readCronState(stateDir);
    expect(state.crons).toHaveLength(1);
    const rec = state.crons[0];
    expect(rec.name).toBe('heartbeat');
    expect(rec.interval).toBe('4h');
    const fireMs = Date.parse(rec.last_fire);
    expect(fireMs).toBeGreaterThanOrEqual(before);
    expect(fireMs).toBeLessThanOrEqual(after);
  });

  it('updates the existing record on a second fire (no duplicate entries)', async () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'HB' }],
    }));

    recordCronFireIfMatch(configPath, 'HB', stateDir);
    const first = readCronState(stateDir).crons[0].last_fire;

    // Sleep a tick so the second timestamp differs.
    await new Promise(res => setTimeout(res, 5));

    recordCronFireIfMatch(configPath, 'HB', stateDir);
    const after = readCronState(stateDir);
    expect(after.crons).toHaveLength(1);
    expect(after.crons[0].last_fire).not.toBe(first);
    expect(Date.parse(after.crons[0].last_fire)).toBeGreaterThan(Date.parse(first));
  });

  it('does nothing when the prompt is not a configured cron', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'HB' }],
    }));
    const match = recordCronFireIfMatch(configPath, '=== TELEGRAM from user', stateDir);
    expect(match).toBeNull();
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(false);
  });

  it('skips entries without a name (no key to record under)', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [{ interval: '4h', prompt: 'unnamed' }],
    }));
    const match = recordCronFireIfMatch(configPath, 'unnamed', stateDir);
    expect(match).toBeNull();
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(false);
  });

  it('does nothing when config file is missing', () => {
    const match = recordCronFireIfMatch(configPath, 'anything', stateDir);
    expect(match).toBeNull();
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(false);
  });

  it('records a fire even when interval is missing', () => {
    writeFileSync(configPath, JSON.stringify({
      crons: [{ name: 'cron-no-interval', prompt: 'NO-INT' }],
    }));
    recordCronFireIfMatch(configPath, 'NO-INT', stateDir);
    const state = readCronState(stateDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('cron-no-interval');
    expect(state.crons[0].interval).toBeUndefined();
  });
});
