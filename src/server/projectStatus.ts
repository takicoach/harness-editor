import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { nextObservationSeq } from './observationSeq';
import type { ProjectSteps } from '../shared/types';
import { STALE_AFTER_MS } from '../shared/staleThreshold';
import {
  isDisplayStatus,
  parseProjectStage,
  DISPLAY_STATUSES,
  type DisplayStatus,
  type ProjectStage,
} from '../shared/projectStage';

const TELOP_DIR = 'テロップテンプレート';

/** 後方互換 re-export（App.tsx / HomeDashboard 等の既存 import 先）。正本は shared/projectStage。 */
export type { ProjectStage, DisplayStatus } from '../shared/projectStage';

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
  /** 工程ステッパーの判定結果（resolveProjectSteps）。自動判定の唯一の材料。 */
  steps: ProjectSteps;
  stage: ProjectStage;
  activity: StatusActivity | null;
  /** 現在時刻（ミリ秒）。stale 判定に使う。テストで注入する。 */
  now: number;
}

/** resolveStatus の返り値（ProjectSummary へ spread される付加フィールド）。 */
export interface ResolvedStatus {
  status: DisplayStatus;
  /** 手動 stage による固定か（.sme/status.json の stage が非 null）。「手動」バッジ表示用。 */
  stageManual?: boolean;
  activityLabel?: string;
  activityStartedAt?: string;
  activityStale?: boolean;
}

/**
 * 工程ステッパーの結果から自動ステータスを導く純関数＝「最初の未完了工程」。
 * 判定材料は steps のみ（工程ステッパーと同じ事実を二重に判定しない）。
 * 全工程を終えていても未書き出しなら最後の編集工程 'audio' に留まる
 * （書き出しは工程ではなく成果物の有無で 'rendered' へ移る）。
 */
export function autoStatusFromSteps(steps: ProjectSteps): DisplayStatus {
  if (steps.rendered) return 'rendered';
  const telopDone = steps.telop === 'nonempty';
  // どの工程にも着手していないものだけを「未着手」と呼ぶ（着手済みなら未完了工程を指す）。
  if (!steps.transcribe && !steps.cut && !telopDone && !steps.audio) return 'idle';
  if (!steps.transcribe) return 'transcribe';
  if (!steps.cut) return 'cut';
  if (!telopDone) return 'telop';
  return 'audio';
}

/**
 * ステータスを解決する純関数。
 * 優先順位: 手動 stage（D&D・バッジメニューでの固定）> 自動判定（autoStatusFromSteps）。
 * activity は status を変えず、付加フィールド（バッジ用）として返す。
 */
export function resolveStatus(input: ResolveStatusInput): ResolvedStatus {
  const status: DisplayStatus = input.stage ?? autoStatusFromSteps(input.steps);

  const out: ResolvedStatus = { status };
  if (input.stage !== null) out.stageManual = true;
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

/** `.sme/status.json` の読み取り上限（巨大ファイルによる一覧走査の DoS 防止）。 */
export const MAX_STATUS_FILE_BYTES = 64 * 1024;

/**
 * `.sme/status.json` を読み取り正規化する。
 * ファイルなし・壊れた JSON・未知フィールドは黙って無視し、自動判定フォールバック
 * （{ stage: null, activity: null }）を返す。エディタは決して落とさない。
 */
export function readStatusFile(dir: string): StatusFileData {
  const path = join(dir, '.sme', 'status.json');
  let raw: string;
  try {
    // FIFO やキャラクタデバイスは size=0 で上限を素通りし、readFileSync が書き手を待って
    // 恒久ブロックする（scanProjects→resolveProjectStatus 経由で一覧 API と SSE が固まる）。
    // projectSteps / scanProjects と同じガードをこの走査経路にも一貫適用する。
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_STATUS_FILE_BYTES) {
      return { stage: null, activity: null };
    }
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
  return { stage: parseProjectStage(obj['stage']), activity: parseActivity(obj['activity']) };
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
 * 自動判定の材料は呼び出し側が解決済みの steps（工程ステッパーと同一の値）を渡す
 * — 同じ事実をここで再判定しない。ここが見る IO は mtime（lastEditedAt）だけ。
 *
 * 返り値には観測シーケンス `statusSeq` を必ず載せる。一覧（`/api/projects`）と
 * SSE 差分（projectsWatch）はどちらもこの関数を通るため、**どちらの観測が新しいか**を
 * クライアントが到着順ではなく番号で判定できる（out-of-order 対策の正本）。
 * 採番は `readStatusFile` と同じ同期ブロック内で行う — Node のシングルスレッド性により、
 * 番号の大小がそのまま読み取りの前後関係になる（observationSeq.ts の説明を参照）。
 */
export function resolveProjectStatus(
  dir: string,
  steps: ProjectSteps,
  now: number = Date.now(),
): ResolvedStatus & { lastEditedAt?: number; statusSeq: number } {
  const { stage, activity } = readStatusFile(dir);
  const statusSeq = nextObservationSeq();

  const nativeMtime = mtimeOrNull(join(dir, '.harness', 'project.v2.json'));
  if (nativeMtime !== null) return { ...resolveStatus({ steps, stage, activity, now }), statusSeq, lastEditedAt: nativeMtime };

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
    if (lastEditedAt === undefined || mt > lastEditedAt) lastEditedAt = mt;
  }

  const resolved = { ...resolveStatus({ steps, stage, activity, now }), statusSeq };
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
  // **一時ファイル → rename** で置き換える（同一ディレクトリなので rename は原子的）。
  // 直接 writeFileSync すると、書き終える前に読んだ側が**切れた JSON** を掴む。
  // 実測（フルスイート e2e・2026-09-06）: 書き込み直後をポーリングしていたテストが
  // `SyntaxError: Unexpected end of JSON input` で落ちた。読み手は e2e だけではない——
  // `readStatusFile` は解析に失敗すると「stage なし（自動判定）」へフォールバックするため、
  // 一覧の走査や watcher がこの瞬間を踏むと**バッジが一瞬まちがった状態を表示する**。
  const target = join(smeDir, 'status.json');
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    // 失敗しても一時ファイルを残さない（残骸は一覧の走査に混ざる）。
    try {
      unlinkSync(tmp);
    } catch {
      /* 既に無いなら何もしない */
    }
    throw err;
  }
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
  if (stage !== null && !isDisplayStatus(stage)) {
    throw new HttpError(
      400,
      `stage は ${DISPLAY_STATUSES.map((s) => `"${s}"`).join(' / ')} / null のいずれかである必要があります`,
    );
  }
  return { id: b['id'], stage };
}
