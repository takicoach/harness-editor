import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exportedArrayEntriesState, telopEntriesState } from '../core/telopStatic';
import type { ProjectSteps, TelopStepState } from '../shared/types';
import { SequenceStore } from './sequence/store';
import { hasSequenceDocument, sequenceSteps } from './sequence/summary';

const TELOP_DIR = 'テロップテンプレート';
/** cutData.ts の探索候補（loadProjectFiles.ts の CUT_DATA_CANDIDATES と同値）。 */
const CUT_DATA_CANDIDATES = ['cutData.ts', 'src/cutData.ts', `src/${TELOP_DIR}/cutData.ts`];

/** telopData.ts の静的読み取り上限。一覧走査は信頼していないプロジェクトも読むため。 */
export const MAX_TELOP_STATIC_BYTES = 2 * 1024 * 1024;

/**
 * transcript.json の読み取り上限。これを超えるサイズの transcript が「空」である
 * ことはあり得ないので、超過分はパースせずに済扱いにする
 * （一覧走査のたびに巨大 JSON を parse し続けない）。
 */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export type { ProjectSteps };

/**
 * サイズ上限つきでテキストを読む。読めない・通常ファイルでない・上限超過は null。
 * FIFO やキャラクタデバイスは size=0 で上限を素通りし、readFileSync が書き手を待って
 * 恒久ブロックする（一覧走査が固まる）ため、通常ファイルであることも併せて要求する。
 */
function readCapped(path: string, maxBytes: number): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * データファイルに**静的エントリが 1 件以上あるか**。
 *
 * 雛形（project-template）は seData.ts / bgmData.ts を**空配列で同梱**するため、
 * ファイルの有無で判定すると新規作成した瞬間に「SE・BGM 済み」になる。
 * telop と同じくエントリ数で判定する。読めない・壊れている場合は「未済」に倒す
 * （読めないものを済扱いにしない）。
 */
function hasStaticEntries(path: string, exportName: string): boolean {
  const source = readCapped(path, MAX_TELOP_STATIC_BYTES);
  return source !== null && exportedArrayEntriesState(source, exportName) === 'nonempty';
}

/**
 * transcript.json に**文字起こしの中身があるか**。
 *
 * createProject は「文字起こし前でもエディタで開ける」よう
 * `{ words: [], segments: [] }` の空 transcript.json を必ず書く。存在だけで
 * 判定すると新規作成した瞬間に「文字起こし済み」になる。
 * segments / words のどちらかに要素があれば済み（エンジンによって
 * segments を持たないものがある）。壊れた JSON は未済に倒す。
 */
function hasTranscriptContent(path: string): boolean {
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  // 8MB 超の transcript が空であることはあり得ない（読まずに済扱い）。
  if (st.size > MAX_TRANSCRIPT_BYTES) return true;
  const source = readCapped(path, MAX_TRANSCRIPT_BYTES);
  if (source === null) return false;
  try {
    const parsed = JSON.parse(source) as { segments?: unknown; words?: unknown };
    const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
    return n(parsed.segments) > 0 || n(parsed.words) > 0;
  } catch {
    return false;
  }
}

/**
 * 工程ステッパーの自動判定。コードは実行せず、静的抽出（telop / se / bgm）と
 * JSON パース（transcript）だけで判定する。summarize（scanProjects）から呼ばれる。
 *
 * 「ファイルの有無」で足りるのは cutData と out/video.mp4 だけ。
 * cutData.ts は雛形に含まれず createProject も書かない（＝実際に編集して保存した
 * ときだけ生える）ので、有無判定で新規プロジェクトを誤判定することはない。
 */
export function resolveProjectSteps(dir: string): ProjectSteps {
  if (hasSequenceDocument(dir)) {
    const saved = new SequenceStore(dir).load();
    if (!saved) throw new Error('保存された編集内容を読み込めません');
    return sequenceSteps(dir, saved);
  }
  const telopSource = readCapped(join(dir, 'src', TELOP_DIR, 'telopData.ts'), MAX_TELOP_STATIC_BYTES);
  const telop: TelopStepState = telopSource === null ? 'invalid' : telopEntriesState(telopSource);
  return {
    transcribe: hasTranscriptContent(join(dir, 'transcript.json')),
    cut: CUT_DATA_CANDIDATES.some((rel) => existsSync(join(dir, rel))),
    telop,
    audio:
      hasStaticEntries(join(dir, 'src', 'SoundEffects', 'seData.ts'), 'seData') ||
      hasStaticEntries(join(dir, 'src', 'Bgm', 'bgmData.ts'), 'bgmData'),
    rendered: existsSync(join(dir, 'out', 'video.mp4')),
  };
}
