/**
 * learn スキルの取り出し（harvest_v2）の「取り出し済み台帳」harvest_v2_state.json への記録。
 *
 * エディターのパネルで1件以上承認した取り込み案件を projects[documentId] に書くと、配布済みの harvest_v2 は
 * その案件を already-harvested として止まる（設計書 D11。harvest_v2 は内容を問わず、記録があれば止まる）。
 * 既存の項目は保持し、読み直してから一時ファイル経由で置き換える（D12）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LearningApproveRequest } from '../../shared/types';
import { cutCandidateKey, seCandidateKey, telopCandidateKey } from './nativeLearningRules';

export const HARVEST_LEDGER_FILE = 'harvest_v2_state.json';

/** カテゴリ → 種類 → 件数（harvest_v2 の counts と同じ形）。 */
export interface HarvestCounts {
  cut: Record<string, number>;
  telop: Record<string, number>;
  se: Record<string, number>;
}

export interface EditorPanelHarvest {
  videoId: string;
  projectDir: string;
  harvestedAt: string;
  documentRevision: number;
  counts: HarvestCounts;
  source: 'editor-panel';
}

const tally = (kinds: string[]): Record<string, number> =>
  kinds.reduce<Record<string, number>>((counts, kind) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }), {});

/** 照合キーが同じ項目を最初の1件だけ残す（順序は保つ）。 */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 承認要求の cut / telops / ses から、同じ要求の中で重複した項目を除く（候補の照合キーで比べる）。 */
export function uniqueApproved<T extends Pick<LearningApproveRequest, 'cut' | 'telops' | 'ses'>>(body: T):
  T & Required<Pick<LearningApproveRequest, 'cut' | 'telops' | 'ses'>> {
  return { ...body, cut: uniqueBy(body.cut, cutCandidateKey), telops: uniqueBy(body.telops ?? [], telopCandidateKey),
    ses: uniqueBy(body.ses ?? [], seCandidateKey) };
}

/** 承認した項目を種類ごとに数える（同じ要求の中の重複は1件として数える）。 */
export function countApprovedByKind(body: Pick<LearningApproveRequest, 'cut' | 'telops' | 'ses'>): HarvestCounts {
  const unique = uniqueApproved(body);
  return {
    cut: tally(unique.cut.map((c) => c.kind)),
    telop: tally(unique.telops.map((t) => t.kind)),
    se: tally(unique.ses.map((s) => s.kind)),
  };
}

/** 台帳の projects[documentId] を書く。台帳が壊れていれば上書きせずに例外を投げる。 */
export function recordEditorPanelHarvest(learnDir: string, documentId: string, entry: EditorPanelHarvest): void {
  const file = join(learnDir, HARVEST_LEDGER_FILE);
  mkdirSync(learnDir, { recursive: true });
  const current: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, projects: {} };
  if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new Error(`${HARVEST_LEDGER_FILE} の形式が不正です`);
  const projects = (current as { projects?: unknown }).projects;
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) throw new Error(`${HARVEST_LEDGER_FILE} の projects が不正です`);
  const next = { ...current, projects: { ...projects, [documentId]: entry } };
  const temporary = join(learnDir, `${HARVEST_LEDGER_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
