import type { OrientationCode } from './orientation';
import type { DisplayStatus } from './projectStage';
import type { EditorProject } from '../core/types';

/** telopData の静的三値判定結果（src/core/telopStatic.ts と同値集合）。 */
export type TelopStepState = 'empty' | 'nonempty' | 'invalid';

/**
 * 工程ステッパーの自動判定（データファイルの有無ベース・手入力なし）。
 * 文字起こし→カット→テロップ→SE/BGM→書き出し。カンバン列とは独立した情報表示。
 */
export interface ProjectSteps {
  transcribe: boolean;
  cut: boolean;
  telop: TelopStepState;
  audio: boolean;
  rendered: boolean;
}

/**
 * アップロード取り込みの結果。実体をコピーしたか、外付けの実体へリンクしたか。
 * message は非エンジニア向けの日本語（クライアントはそのままトーストに出す）。
 */
export type ImportOutcome =
  | { linked: true; target: string; message: string }
  | { linked: false; reason: string; message: string };

/** フォルダブラウザに並ぶ 1 プロジェクトの要約。サーバが生成しクライアントが消費する。 */
export interface ProjectSummary {
  /** ルートからの相対パス（= ディレクトリ名）。API の id として使う。 */
  id: string;
  name: string;
  /**
   * 保存先の絶対パス（表示用）。旧サーバの応答と互換を保つため optional
   * （無ければホームは「保存先」行を出さない）。開く操作は id 経由で行い、
   * この値をサーバへ送り返すことはしない。
   */
  dir?: string;
  orientation: OrientationCode;
  /** 例 "1:45" */
  durationLabel: string;
  /** 例 "96 MB" */
  sizeLabel: string;
  /** public/ 配下の動画ファイル名（サムネイル用）。未配置なら null。リンク切れでは保持する。 */
  videoFile: string | null;
  /** メイン動画が外部実体への symlink の場合の接続先と状態（外付け取り込み）。通常は undefined。 */
  videoLink?: { target: string; state: 'ok' | 'broken' | 'mismatch' };
  /** 解決済みの表示ステータス（手動 stage > 自動判定）。表示ステータス全値の正本は shared/projectStage。 */
  status: DisplayStatus;
  /** 手動 stage による固定か（.sme/status.json の stage が非 null）。「手動」バッジ表示用。 */
  stageManual?: boolean;
  /** AI 作業中の工程名（`.sme/status.json` の activity）。無ければ undefined。 */
  activityLabel?: string;
  /** activity の開始時刻（ISO 8601）。無ければ undefined。 */
  activityStartedAt?: string;
  /** activity が 2 時間超経過し中断疑い（スピナー停止・グレー化）なら true。 */
  activityStale?: boolean;
  /** 編集データファイル群の最新 mtimeMs（相対最終編集日時表示用）。無ければ undefined。 */
  lastEditedAt?: number;
  /**
   * 工程ステッパー（自動判定）。現行サーバは一覧・SSE 差分の両方で常に載せる。
   * optional なのは steps を知らない旧サーバのレスポンスと互換を保つため
   * （その場合はステッパーを表示しない）。
   * 既知の制限: SSE で live に変わるのは rendered だけ（watcher が .sme と out しか通さない）。
   * transcribe/cut/telop/audio は次の refreshProjects まで更新されない。
   */
  steps?: ProjectSteps;
}

/**
 * 書き戻し対象ファイル 1 つの指紋（外部変更検知用）。
 * パスはルートからの相対。size はバイト数、mtimeMs はミリ秒。
 */
export interface FileFingerprint {
  /** プロジェクトディレクトリからの相対パス。 */
  relPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * プロジェクト読込時に記録する、書き戻し対象ファイル群の指紋。
 * 保存直前にこれを送り返し、サーバが現在のディスク状態と照合する。
 */
export interface ProjectFingerprint {
  telopData: FileFingerprint;
  /** cutData.ts が読込時に存在しなければ null（保存時に新規作成する）。 */
  cutData: FileFingerprint | null;
  /** seData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。 */
  seData: FileFingerprint | null;
  /** insertImageData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。 */
  insertImageData: FileFingerprint | null;
  /** insertVideoData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。 */
  videoInsertData: FileFingerprint | null;
  /** bgmData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。 */
  bgmData: FileFingerprint | null;
  /** titleData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。 */
  titleData: FileFingerprint | null;
  /** shapeData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。旧クライアントは送らない（undefined）。 */
  shapeData?: FileFingerprint | null;
  /** transitionData.ts が読込時に存在しなければ null（保存時に新規作成しうる）。旧クライアントは送らない（undefined）。 */
  transitionData?: FileFingerprint | null;
  /** speedData.ts が読込時に存在しなければ null（mainSpeed=1 では不要）。旧クライアントは送らない（undefined）。 */
  speedData?: FileFingerprint | null;
  /** mainLayoutData.ts が読込時に存在しなければ null（既定レイアウトでは不要）。旧クライアントは送らない（undefined）。 */
  mainLayoutData?: FileFingerprint | null;
}

/** PUT /api/project の送信ボディ。 */
export interface SaveRequest {
  /** 編集済みの EditorProject（クライアントの EditState から合成したもの）。 */
  project: EditorProject;
  /** 読込時に受け取った指紋。外部変更検知に使う。 */
  fingerprint: ProjectFingerprint;
}

/** PUT /api/project の成功レスポンス。 */
export interface SaveResponse {
  ok: true;
  /** 書き戻し後の新しい指紋。クライアントは次回保存のためこれを保持する。 */
  fingerprint: ProjectFingerprint;
}

/** 画面の指示に添付する「今見ている文脈」。 */
export interface InstructionContext {
  /** 送信時の再生ヘッド（フレーム）。 */
  frame: number;
  /** 同・秒（fps から換算してクライアントが付与）。 */
  timeSec: number;
  /** 選択中の要素。無選択は null。 */
  selection: { kind: 'telop' | 'image' | 'videoInsert' | 'bgm' | 'se' | 'title' | 'shape'; id: string } | null;
}

/** 指示の処理状態。 */
export type InstructionStatus = 'pending' | 'processing' | 'done' | 'failed';

/** 受け箱に積まれる 1 指示。サーバが採番・保持し、画面と Claude Code が参照する。 */
export interface InstructionRecord {
  id: string;
  projectId: string;
  /** 解決済み絶対パス。Claude が編集対象を一意に特定するために使う。 */
  projectDir: string;
  text: string;
  context: InstructionContext;
  status: InstructionStatus;
  /** Claude の一言返答（done/failed 時）。無ければ null。 */
  reply: string | null;
  createdAt: number;
  updatedAt: number;
}

/** POST /api/instructions の送信ボディ（projectDir はサーバが解決するため含めない）。 */
export interface InstructionInput {
  projectId: string;
  text: string;
  context: InstructionContext;
}

/** GET /api/learning/diff のカット差分 1 項目。 */
export interface LearningCutDiffItem {
  kind: 'added-cut' | 'restored-cut';
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  /** 区間内の word テキスト連結（空なら '(無音)'）。 */
  text: string;
}

/** GET /api/learning/diff の文字起こし差分 1 項目（誤→正）。 */
export interface LearningWordDiffItem {
  before: string;
  after: string;
}

/** GET /api/learning/diff のテロップ差分 1 項目。テキストのみ（スタイル/テンプレは対象外）。 */
export interface LearningTelopDiffItem {
  kind: 'changed' | 'added' | 'removed';
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  /** removed/changed で有効。added は ''。 */
  before: string;
  /** added/changed で有効。removed は ''。 */
  after: string;
}

/** GET /api/learning/diff の SE 差分 1 項目。added=人間が足した／removed=AI配置を人間が外した。 */
export interface LearningSeDiffItem {
  kind: 'added' | 'removed';
  startFrame: number;
  startSec: number;
  file: string;
  /** 近傍テロップのテキスト（無ければ ''）。 */
  nearbyText: string;
}

/** GET /api/learning/diff のレスポンス。 */
export interface LearningDiffResponse {
  /** null = カットベースラインなし（スキップ）。 */
  cut: LearningCutDiffItem[] | null;
  /** null = transcript ベースラインなし。 */
  words: LearningWordDiffItem[] | null;
  /** null = telopData ベースラインなし。 */
  telops: LearningTelopDiffItem[] | null;
  /** null = seData ベースラインなし。 */
  ses: LearningSeDiffItem[] | null;
  undistilledCount: number;
}

/** POST /api/learning/approve の送信ボディ（承認された項目のみ）。 */
export interface LearningApproveRequest {
  projectId: string;
  cut: LearningCutDiffItem[];
  words: LearningWordDiffItem[];
  /** 後方互換: 未指定なら空配列扱い。 */
  telops?: LearningTelopDiffItem[];
  /** 後方互換: 未指定なら空配列扱い。 */
  ses?: LearningSeDiffItem[];
}

/** POST /api/learning/approve のレスポンス。 */
export interface LearningApproveResponse {
  cutRulesPromoted: number;
  cutConflicts: number;
  wordsPromoted: number;
  wordConflicts: number;
  telopRulesPromoted: number;
  telopConflicts: number;
  seRulesPromoted: number;
  seConflicts: number;
  undistilledCount: number;
}
