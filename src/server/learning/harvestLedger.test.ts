import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countApprovedByKind, HARVEST_LEDGER_FILE, recordEditorPanelHarvest, type EditorPanelHarvest } from './harvestLedger';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function learnDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ledger-'));
  dirs.push(dir);
  return dir;
}
const entry: EditorPanelHarvest = { videoId: 'case-a', projectDir: '/p/case-a', harvestedAt: '2026-09-25T00:00:00.000Z', documentRevision: 3,
  counts: { cut: { 'added-cut': 1 }, telop: {}, se: {} }, source: 'editor-panel' };

describe('recordEditorPanelHarvest', () => {
  it('台帳が無ければ version:1 で作り、projects[documentId] に書く', () => {
    const dir = learnDir();
    recordEditorPanelHarvest(dir, 'doc-a', entry);
    expect(JSON.parse(readFileSync(join(dir, HARVEST_LEDGER_FILE), 'utf8'))).toEqual({ version: 1, projects: { 'doc-a': entry } });
    expect(readdirSync(dir)).toEqual([HARVEST_LEDGER_FILE]); // 一時ファイルを残さない
  });

  it('既存の案件と上位の項目を保持する', () => {
    const dir = learnDir();
    const existing = { version: 1, note: 'keep', projects: { 'doc-b': { videoId: 'b', harvestedAt: 'x', documentRevision: 1, counts: {} } } };
    writeFileSync(join(dir, HARVEST_LEDGER_FILE), JSON.stringify(existing));
    recordEditorPanelHarvest(dir, 'doc-a', entry);
    expect(JSON.parse(readFileSync(join(dir, HARVEST_LEDGER_FILE), 'utf8'))).toEqual({ ...existing, projects: { ...existing.projects, 'doc-a': entry } });
  });

  it('壊れた台帳は上書きせずに例外にする', () => {
    const dir = learnDir();
    writeFileSync(join(dir, HARVEST_LEDGER_FILE), '{broken');
    expect(() => recordEditorPanelHarvest(dir, 'doc-a', entry)).toThrow();
    expect(readFileSync(join(dir, HARVEST_LEDGER_FILE), 'utf8')).toBe('{broken');
    writeFileSync(join(dir, HARVEST_LEDGER_FILE), JSON.stringify({ version: 1, projects: [] }));
    expect(() => recordEditorPanelHarvest(dir, 'doc-a', entry)).toThrow('projects');
    expect(readdirSync(dir)).toEqual([HARVEST_LEDGER_FILE]);
  });
});

describe('countApprovedByKind', () => {
  it('カテゴリごとに種類別の件数を数える（harvest_v2 の counts と同じ形）', () => {
    // 別々の区間の2件（同じ区間・同じ語の2件は同じ項目の重複として1件に数える）。
    const cut = (kind: 'added-cut' | 'restored-cut', startFrame = 0) => ({ kind, startFrame, endFrame: startFrame + 3, startSec: 0, endSec: 0.1, text: 'a' });
    expect(countApprovedByKind({ cut: [cut('added-cut'), cut('added-cut', 30), cut('restored-cut')],
      telops: [{ kind: 'changed', startFrame: 0, endFrame: 1, startSec: 0, endSec: 0, before: 'a', after: 'b' }] }))
      .toEqual({ cut: { 'added-cut': 2, 'restored-cut': 1 }, telop: { changed: 1 }, se: {} });
  });
});
