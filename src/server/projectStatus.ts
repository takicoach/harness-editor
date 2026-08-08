import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { STALE_AFTER_MS } from '../shared/staleThreshold';

const TELOP_DIR = 'テロップテンプレート';

/** `.sme/status.json` に書かれる手動ステージ。null は自動判定に戻すことを表す。 */
export type ProjectStage = 'review' | 'published' | null;

/** AI 作業中の activity（存在すれば最優先でバッジ表示）。 */
export interface StatusActivity {
  label: string;
  /** ISO 8601 文字列。stale 判定に使う。 */
  startedAt: string;
}

/** `.sme/status.json` を読み取り・正規化した結果。 */
export interface StatusFileData {
  stage: ProjectStage;
  activity: StatusActivity | null;
}

/** resolveStatus に渡す解決済みの事実（IO 済み）。テスト容易化のため純データにする。 */
export interface ResolveStatusInput {
  /** out/video.mp4 が存在するか。 */
  hasRenderedOutput: boolean;
  /** telopData 以外の編集データファイルがいずれか存在するか。 */
  hasEditData: boolean;
  stage: ProjectStage;
  activity: StatusActivity | null;
  /** 現在時刻（ミリ秒）。stale 判定に使う。テストで注入する。 */
  now: number;
}

/** 解決済みの表示ステータス。 */
export type DisplayStatus = 'idle' | 'editing' | 'rendered' | 'review' | 'published';

/** resolveStatus の返り値（ProjectSummary へ spread される付加フィールド）。 */
export interface ResolvedStatus {
  status: DisplayStatus;
  activityLabel?: string;
  activityStartedAt?: string;
  activityStale?: boolean;
}

/**
 * ステータスを解決する純関数。
 * 優先順位: 手動 stage（review/published）> 自動判定（rendered > editing > idle）。
 * activity は status を変えず、付加フィールド（バッジ用）として返す。
 */
export function resolveStatus(input: ResolveStatusInput): ResolvedStatus {
  const auto: DisplayStatus = input.hasRenderedOutput
    ? 'rendered'
    : input.hasEditData
      ? 'editing'
      : 'idle';
  const status: DisplayStatus = input.stage ?? auto;

  const out: ResolvedStatus = { status };
  if (input.activity) {
    out.activityLabel = input.activity.label;
    out.activityStartedAt = input.activity.startedAt;
    const started = Date.parse(input.activity.startedAt);
    // 解析不能な startedAt は stale 扱いにしない（バッジは残す）。
    out.activityStale = Number.isNaN(started) ? false : input.now - started > STALE_AFTER_MS;
  }
  return out;
}

/** unknown を検証して StatusActivity へ。不正なら null。 */
function parseActivity(value: unknown): StatusActivity | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a['label'] !== 'string' || typeof a['startedAt'] !== 'string') return null;
  return { label: a['label'], startedAt: a['startedAt'] };
}

/** unknown を検証して ProjectStage へ。不正・未知値は null。 */
function parseStage(value: unknown): ProjectStage {
  return value === 'review' || value === 'published' ? value : null;
}

/**
 * `.sme/status.json` を読み取り正規化する。
 * ファイルなし・壊れた JSON・未知フィールドは黙って無視し、自動判定フォールバック
 * （{ stage: null, activity: null }）を返す。エディタは決して落とさない。
 */
export function readStatusFile(dir: string): StatusFileData {
  const path = join(dir, '.sme', 'status.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { stage: null, activity: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[sme] status.json の解析に失敗（自動判定にフォールバック）: ${path}`);
    return { stage: null, activity: null };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { stage: null, activity: null };
  }
  const obj = parsed as Record<string, unknown>;
  return { stage: parseStage(obj['stage']), activity: parseActivity(obj['activity']) };
}

/**
 * 編集データファイル群（プロジェクトディレクトリからの相対パス）。
 * telop 以外は「編集された」判定に、telop も含めて lastEditedAt の算出に使う。
 */
const TELOP_DATA_REL = `src/${TELOP_DIR}/telopData.ts`;
const EDIT_DATA_RELS = [
  'cutData.ts',
  'src/cutData.ts',
  `src/${TELOP_DIR}/cutData.ts`,
  'src/SoundEffects/seData.ts',
  'src/InsertImage/insertImageData.ts',
  'src/InsertVideo/insertVideoData.ts',
  'src/Bgm/bgmData.ts',
  'src/Title/titleData.ts',
  'src/InsertShape/shapeData.ts',
  'src/Transition/transitionData.ts',
  'src/speedData.ts',
  'src/mainLayoutData.ts',
];

/** ファイルの mtimeMs を返す。存在しなければ null。 */
function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * プロジェクトディレクトリからステータス（表示用フィールド）を解決する。
 * summarize から呼ばれ、返り値を ProjectSummary へ spread する。
 */
export function resolveProjectStatus(
  dir: string,
  now: number = Date.now(),
): ResolvedStatus & { lastEditedAt?: number } {
  const { stage, activity } = readStatusFile(dir);
  const hasRenderedOutput = existsSync(join(dir, 'out', 'video.mp4'));

  let hasEditData = false;
  let lastEditedAt: number | undefined;
  // telopData は lastEditedAt に算入するが「編集された」判定には使わない
  // （生成直後から必ず存在するため）。
  const telopMtime = mtimeOrNull(join(dir, TELOP_DATA_REL));
  if (telopMtime !== null) {
    lastEditedAt = telopMtime;
  }
  for (const rel of EDIT_DATA_RELS) {
    const mt = mtimeOrNull(join(dir, rel));
    if (mt === null) continue;
    hasEditData = true;
    if (lastEditedAt === undefined || mt > lastEditedAt) lastEditedAt = mt;
  }

  const resolved = resolveStatus({ hasRenderedOutput, hasEditData, stage, activity, now });
  return lastEditedAt === undefined ? resolved : { ...resolved, lastEditedAt };
}

/**
 * `.sme/status.json` の stage のみ更新する（activity は保持）。
 * `.sme` ディレクトリが無ければ作成する。
 */
export function writeStatusStage(dir: string, stage: ProjectStage): StatusFileData {
  const existing = readStatusFile(dir);
  const next: StatusFileData = { stage, activity: existing.activity };
  const smeDir = join(dir, '.sme');
  mkdirSync(smeDir, { recursive: true });
  writeFileSync(join(smeDir, 'status.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** POST /api/project/status のリクエストボディ。 */
export interface StatusRequest {
  id: string;
  stage: ProjectStage;
}

/** POST /api/project/status の body を検証する。不正なら HttpError(400)。 */
export function validateStatusRequest(body: unknown): StatusRequest {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'リクエストボディがオブジェクトではありません');
  }
  const b = body as Record<string, unknown>;
  if (typeof b['id'] !== 'string' || b['id'] === '') {
    throw new HttpError(400, 'id が必要です');
  }
  const stage = b['stage'];
  if (stage !== 'review' && stage !== 'published' && stage !== null) {
    throw new HttpError(400, 'stage は "review" / "published" / null のいずれかである必要があります');
  }
  return { id: b['id'], stage };
}
