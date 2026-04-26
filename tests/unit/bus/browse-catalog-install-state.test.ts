import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { browseCatalog } from '../../../src/bus/catalog';

/**
 * `browseCatalog` previously decided `installed` from `.installed-community.json`
 * alone. Anything copied in manually, installed by an earlier framework
 * version that didn't write the registry, or migrated from another agent
 * showed as not-installed in the catalog UI — and the install action would
 * then fail with `already_exists` because the target path was occupied.
 *
 * The fix cross-checks the actual install target on disk: skills under
 * `<agentDir>/.claude/skills/<name>`, agents under `templates/personas/<name>`,
 * orgs under `templates/orgs/<name>`.
 */

interface CatalogEntry {
  name: string;
  type: 'skill' | 'agent' | 'org';
  install_path: string;
}

function writeCatalog(frameworkRoot: string, entries: CatalogEntry[]) {
  const catalog = {
    version: '1.0.0',
    updated_at: '2026-04-26T00:00:00Z',
    items: entries.map(e => ({
      name: e.name,
      description: 'test',
      author: 'test',
      type: e.type,
      version: '1.0.0',
      tags: [],
      review_status: 'community',
      dependencies: [],
      install_path: e.install_path,
      submitted_at: '2026-04-26T00:00:00Z',
    })),
  };
  mkdirSync(join(frameworkRoot, 'community'), { recursive: true });
  writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify(catalog));
}

describe('browseCatalog — install state detection (filesystem + registry)', () => {
  let frameworkRoot: string;
  let ctxRoot: string;
  let agentDir: string;

  beforeEach(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'browse-fw-'));
    ctxRoot = mkdtempSync(join(tmpdir(), 'browse-ctx-'));
    agentDir = mkdtempSync(join(tmpdir(), 'browse-agent-'));
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('marks a skill installed when its target directory exists in agentDir, even with no registry entry', () => {
    writeCatalog(frameworkRoot, [{ name: 'tasks', type: 'skill', install_path: 'skills/tasks' }]);
    mkdirSync(join(agentDir, '.claude', 'skills', 'tasks'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'tasks', 'SKILL.md'), '# tasks');

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].installed).toBe(true);
  });

  it('marks a skill NOT installed when neither registry nor target dir has it', () => {
    writeCatalog(frameworkRoot, [{ name: 'tasks', type: 'skill', install_path: 'skills/tasks' }]);

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.items[0].installed).toBe(false);
  });

  it('still marks installed when the registry has a record but the target dir is missing (registry wins)', () => {
    writeCatalog(frameworkRoot, [{ name: 'tasks', type: 'skill', install_path: 'skills/tasks' }]);
    writeFileSync(
      join(ctxRoot, '.installed-community.json'),
      JSON.stringify({ tasks: { version: '1.0.0', type: 'skill', installed_at: 'x', path: '/tmp/x' } }),
    );

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.items[0].installed).toBe(true);
  });

  it('marks an agent installed when templates/personas/<name> exists', () => {
    writeCatalog(frameworkRoot, [{ name: 'analyst', type: 'agent', install_path: 'agents/analyst' }]);
    mkdirSync(join(frameworkRoot, 'templates', 'personas', 'analyst'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.items[0].installed).toBe(true);
  });

  it('marks an org installed when templates/orgs/<name> exists', () => {
    writeCatalog(frameworkRoot, [{ name: 'eng-hq', type: 'org', install_path: 'orgs/eng-hq' }]);
    mkdirSync(join(frameworkRoot, 'templates', 'orgs', 'eng-hq'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.items[0].installed).toBe(true);
  });

  it('falls back to frameworkRoot/.claude/skills when no agentDir is provided (matches installCommunityItem default)', () => {
    writeCatalog(frameworkRoot, [{ name: 'tasks', type: 'skill', install_path: 'skills/tasks' }]);
    mkdirSync(join(frameworkRoot, '.claude', 'skills', 'tasks'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot);
    expect(r.items[0].installed).toBe(true);
  });

  it('reports per-item installed state across a mixed catalog', () => {
    writeCatalog(frameworkRoot, [
      { name: 'tasks', type: 'skill', install_path: 'skills/tasks' },
      { name: 'comms', type: 'skill', install_path: 'skills/comms' },
      { name: 'analyst', type: 'agent', install_path: 'agents/analyst' },
    ]);
    // tasks: on disk
    mkdirSync(join(agentDir, '.claude', 'skills', 'tasks'), { recursive: true });
    // comms: in registry
    writeFileSync(
      join(ctxRoot, '.installed-community.json'),
      JSON.stringify({ comms: { version: '1.0.0', type: 'skill', installed_at: 'x', path: '/tmp/x' } }),
    );
    // analyst: neither

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    const byName = Object.fromEntries(r.items.map(i => [i.name, i.installed]));
    expect(byName).toEqual({ tasks: true, comms: true, analyst: false });
  });

  it('combines with type and search filters without breaking install detection', () => {
    writeCatalog(frameworkRoot, [
      { name: 'tasks', type: 'skill', install_path: 'skills/tasks' },
      { name: 'analyst', type: 'agent', install_path: 'agents/analyst' },
    ]);
    mkdirSync(join(agentDir, '.claude', 'skills', 'tasks'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir, type: 'skill' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].name).toBe('tasks');
    expect(r.items[0].installed).toBe(true);
  });
});
