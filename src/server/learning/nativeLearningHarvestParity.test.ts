/**
 * harvest_v2（learn スキルの取り出し・配布物）との照合。
 * 設計書 D5 の意図的な違い（空の cutData・cutArchive 内のテロップ・分かれたテロップの修正）に当たらない
 * 標準試料で、エディター側の差分と harvest_v2 の dry-run が同じ記録内容になることを確かめる。
 * harvest_v2 は別リポジトリ（harness-editor-packs）にある。無い環境では飛ばすが、
 * HARNESS_REQUIRE_HARVEST_V2=1 のときは飛ばさずに失敗させる（計画の検証ではこれを付けて回す）。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeNativeLearningDiff } from './nativeLearningDiff';
import { createImportedProject, standardEdit, standardFinish, type ImportedProjectFixture } from './__fixtures__/importedProject';
import { SILENT_CUT_TEXT } from './nativeLearningRules';

const HARVEST_V2 = process.env['HARVEST_V2_PATH']
  ?? resolve(process.cwd(), '../harness-editor-packs/brain/src/skills-package/skills/learn/scripts/harvest_v2.mjs');
const available = existsSync(HARVEST_V2);
if (!available && process.env['HARNESS_REQUIRE_HARVEST_V2'] === '1') throw new Error(`harvest_v2.mjs がありません: ${HARVEST_V2}`);

let fixture: ImportedProjectFixture | undefined;
let learnDir = '';
let fakeHome = '';
afterEach(() => {
  vi.unstubAllEnvs();
  fixture?.cleanup();
  if (learnDir) rmSync(learnDir, { recursive: true, force: true });
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

interface HarvestDryRun {
  status: string;
  entries: {
    cut: Array<{ kind: string; startFrame: number; endFrame: number; text: string }>;
    telop: Array<{ kind: string; before: string; after: string }>;
    se: Array<{ kind: string; seFile: string; contextText: string }>;
  };
}
const sorted = <T>(items: T[]): string[] => items.map((item) => JSON.stringify(item)).sort();

it.skipIf(!available)('標準試料でエディターの差分と harvest_v2 --dry-run の記録内容が一致する', async () => {
  // 実際の学習フォルダ（~/.video-harness-learning・~/.supermovie-learning）を読まないことを、
  // HOME ごと一時フォルダへ差し替えた状態でテストが通ることで示す。
  fakeHome = mkdtempSync(join(tmpdir(), 'harness-harvest-parity-home-'));
  vi.stubEnv('HOME', fakeHome);
  learnDir = mkdtempSync(join(tmpdir(), 'harness-harvest-parity-'));
  vi.stubEnv('HARNESS_LEARNING_HOME', learnDir);
  fixture = await createImportedProject({ edit: standardEdit, finish: standardFinish });
  const output = execFileSync(process.execPath, [HARVEST_V2, fixture.dir, '--learning-home', learnDir, '--dry-run'], { encoding: 'utf8' });
  const harvest = JSON.parse(output) as HarvestDryRun;
  expect(harvest.status).toBe('dry-run');
  // dry-run は学習フォルダへ何も書かない。
  expect(readdirSync(learnDir)).toEqual([]);
  const { response } = await computeNativeLearningDiff(fixture.dir, fixture.jobId);
  // 存在検査: 照合する中身が空同士の一致になっていないこと（全カテゴリ・全種類が1件以上）。
  expect(harvest.entries.cut.map((e) => e.kind).sort()).toEqual(['added-cut', 'restored-cut']);
  expect(harvest.entries.telop.map((e) => e.kind).sort()).toEqual(['added', 'changed', 'removed']);
  expect(harvest.entries.se.map((e) => e.kind).sort()).toEqual(['added', 'removed']);
  // 記録される形へそろえて比べる（harvest_v2 は無音区間を '' で持つ）。
  expect(sorted((response.cut ?? []).map((c) => ({ kind: c.kind, startFrame: c.startFrame, endFrame: c.endFrame, text: c.text === SILENT_CUT_TEXT ? '' : c.text }))))
    .toEqual(sorted(harvest.entries.cut));
  expect(sorted((response.telops ?? []).map((t) => ({ kind: t.kind, before: t.before, after: t.after })))).toEqual(sorted(harvest.entries.telop));
  expect(sorted((response.ses ?? []).map((s) => ({ kind: s.kind, seFile: s.file, contextText: s.nearbyText })))).toEqual(sorted(harvest.entries.se));
});
