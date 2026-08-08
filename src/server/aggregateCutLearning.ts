import { readdirSync, readFileSync, writeFileSync, Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregateRecords, type AggregatedCutLearning, type CutLearningRecord } from '../core/cutLearning';

const TARGET_FILE = 'cutLearning.json';
/** 降りないディレクトリ。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** root 配下を再帰 walk し、basename が完全に cutLearning.json のファイル絶対パスを集める（昇順）。 */
export function findCutLearningFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return; // 読めないディレクトリはスキップ
    }
    for (const e of entries) {
      const full = join(dir, e.name as string);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name as string)) continue;
        walk(full);
      } else if (e.isFile() && (e.name as string) === TARGET_FILE) {
        out.push(full);
      }
    }
  }
  walk(root);
  out.sort();
  return out;
}

/** 値が集約に必要な最低限の CutLearningRecord 形か（schemaVersion 1 + ruleSummary + video + savedAt）。 */
function isAggregatableRecord(v: unknown): v is CutLearningRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['schemaVersion'] !== 1) return false;
  if (typeof r['savedAt'] !== 'string') return false;
  if (typeof r['video'] !== 'object' || r['video'] === null) return false;
  const rs = r['ruleSummary'];
  if (typeof rs !== 'object' || rs === null) return false;
  const s = rs as Record<string, unknown>;
  return Array.isArray(s['keptByAutoCutByHuman']) && Array.isArray(s['cutByAutoKeptByHuman']);
}

/** 見つけた各 cutLearning.json を読み JSON.parse。壊れ/schema 不一致は warn してスキップ。 */
export function loadCutLearningRecords(root: string): { path: string; record: CutLearningRecord }[] {
  const items: { path: string; record: CutLearningRecord }[] = [];
  for (const path of findCutLearningFiles(root)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.warn(`[sme] ${path} の読込/解析に失敗: スキップ`, err);
      continue;
    }
    if (!isAggregatableRecord(parsed)) {
      console.warn(`[sme] ${path} は cutLearning レコードとして不正: スキップ`);
      continue;
    }
    items.push({ path, record: parsed });
  }
  return items;
}

/** `--key value` 形式の引数を取り出す（src/learning/cli.ts と同形）。 */
function getOption(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** ランキングの上限件数（端末表示を読みやすく保つ）。超過分は件数を添える。 */
const RANKING_TOP_N = 20;

function renderSection(title: string, counts: { text: string; count: number }[]): string {
  if (counts.length === 0) return `${title}: なし`;
  const lines = counts.slice(0, RANKING_TOP_N).map((c) => `  ${c.text} × ${c.count}`);
  const extra = counts.length > RANKING_TOP_N ? `  …他 ${counts.length - RANKING_TOP_N} 件` : '';
  return [title + ':', ...lines, ...(extra ? [extra] : [])].join('\n');
}

/** 集約結果を人が読むランキングテキストへ整形（純関数）。 */
export function renderRanking(agg: AggregatedCutLearning): string {
  return [
    `=== カット学習 集約（${agg.projectCount} プロジェクト）===`,
    renderSection('口癖カット（自動が残し人が切った語）', agg.ruleSummary.keptByAutoCutByHuman),
    '',
    renderSection('切りすぎ傾向（自動が切り人が残した語）', agg.ruleSummary.cutByAutoKeptByHuman),
  ].join('\n');
}

/** 集約 CLI 本体。`--root <dir>`（既定 cwd）, `--out <file>`（既定 cwd/cutLearning-aggregated.json）。 */
export function runAggregateCli(argv: string[]): { code: number; message: string } {
  const root = getOption(argv, 'root') ?? process.cwd();
  const out = getOption(argv, 'out') ?? join(process.cwd(), 'cutLearning-aggregated.json');
  // 出力先が走査対象（`--out .../cutLearning.json`）と一致した場合の自己取り込みを防ぐ。
  const outAbs = resolve(out);
  const items = loadCutLearningRecords(root).filter((i) => resolve(i.path) !== outAbs);
  if (items.length === 0) {
    return { code: 0, message: `対象 cutLearning.json が見つかりませんでした（root: ${root}）` };
  }
  const agg = aggregateRecords(items);
  const fileBody = { generatedAt: new Date().toISOString(), ...agg };
  try {
    writeFileSync(out, JSON.stringify(fileBody, null, 2), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, message: `${out} への書き出しに失敗しました: ${msg}` };
  }
  return {
    code: 0,
    message: `${renderRanking(agg)}\n\n${items.length} 件のプロジェクトを集約し ${out} に書き出しました`,
  };
}
