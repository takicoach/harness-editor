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
  /** Managed v2 media for thumbnails. Never reopen the legacy public video after migration. */
  videoAssetId?: string;
  imageAssetId?: string;
  audioOnly?: boolean;
  /** メイン動画が外部実体への symlink の場合の接続先と状態（外付け取り込み）。通常は undefined。 */
  videoLink?: { target: string; state: 'ok' | 'broken' | 'mismatch' };
  /** 解決済みの表示ステータス（手動 stage > 自動判定）。表示ステータス全値の正本は shared/projectStage。 */
  status: DisplayStatus;
  /**
   * この要約を作った観測（サーバがディスクを読んだ 1 回）の通し番号。単調増加。
   * 一覧の全置換と SSE のライブ差分は届く順番が入れ替わりうるため、クライアントは
   * 到着順ではなくこの番号で新旧を決める（`mergeProjectSummaries` / `applyStatusPatch`）。
   * optional なのは番号を知らないサーバ（旧版）との互換のため。その場合は従来どおり
   * 到着順で上書きする（ライブ更新が止まるより、たまに巻き戻る方がまだ軽い）。
   */
  statusSeq?: number;
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
   * v2 は保存ごとに全工程をSSE更新。旧TSX案件のライブ更新は rendered のみ。
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
  /** mainAudioData.ts が読込時に存在しなければ null（無補正では不要）。旧クライアントは送らない（undefined）。 */
  mainAudioData?: FileFingerprint | null;
  /** shooting-script.json が読込時に存在しなければ null。旧クライアントは送らない（undefined）。 */
  scriptDocument?: FileFingerprint | null;
  /** Independent asset bindings; null before the first independent placement. */
  editorTimeline?: FileFingerprint | null;
}

/** PUT /api/project の送信ボディ。 */
export interface SaveRequest {
  /** 編集済みの EditorProject（クライアントの EditState から合成したもの）。 */
  project: EditorProject;
  /** 読込時に受け取った指紋。外部変更検知に使う。 */
  fingerprint: ProjectFingerprint;
  /**
   * 外部変更を検知しても、この画面の内容で上書きする（既定 false = 従来どおり 409）。
   *
   * 同じプロジェクトは複数の画面から開けるため、後から保存した画面が全ファイルを書き戻し、
   * 先に開いていた画面が 409 で保存不能になることがある（2026-09-04 のデータ損失）。
   * 従来の出口は「開き直してください」だけで、開き直すと未保存の編集が消えた。
   * **利用者が衝突の通知を見たうえで明示的に選んだときだけ** true を送る。
   * 自動保存・再試行からは決して立てない（黙って他方の作業を消さないため）。
   */
  overwrite?: boolean;
}

/** PUT /api/project の成功レスポンス。 */
export interface SaveResponse {
  ok: true;
  /** 書き戻し後の新しい指紋。クライアントは次回保存のためこれを保持する。 */
  fingerprint: ProjectFingerprint;
  /**
   * C-2: サブ動画がソース実長を超えていて保存時にクランプ（originalEnd を短縮）された場合、
   * その正規化後の値。クランプが1件も起きなければ省略（undefined）。
   *
   * 保存はディスク上の値をクランプするが、クライアントが送った編集内容（クランプ前）を
   * そのまま「保存済み」として確定すると、タイムライン・プレビュー・超過警告が
   * ディスクの実体と無言で食い違う（次に開くとクリップが短くなっている）。
   * クライアントはこれを見て、往復中に利用者がさらに編集していなければ画面へ反映し、
   * クランプが起きたことを通知する。
   */
  clampedVideoInserts?: { id: number; originalEnd: number; timelinePlacement?: import('../core/timelinePlacement').TimelinePlacement }[];
  /**
   * X-2(a): クランプでは直せないサブ動画（イン点がソース終端以降・再生速度が高すぎる等で
   * 再生できるソースフレームが1枚も残っていない）。該当が無ければ省略（undefined）。
   *
   * データは変更しない（非破壊）。黙って通すと書き出しで初めて壊れているのが分かるため、
   * クライアントは保存後の通知として利用者へ伝え、イン点の修正か削除を促す。
   */
  unplayableVideoInserts?: { id: number; file: string }[];
  /**
   * 上書き保存で消した内容の退避先（プロジェクトからの相対パス・data-safety-4）。
   * 通常保存では付かない。UI はここを「以前の内容の控え」として案内する。
   */
  backupDir?: string;
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
  requestId?: string;
  requestCreatedAt?: number;
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
  requestId?: string;
  requestCreatedAt?: number;
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
  /** 新形式の比較元が無いなど、候補を比較できなかった理由。 */
  unavailableReason?: string;
  /** 新形式（取り込み案件）のみ。取り込み後に入った AI の編集の回数（1以上ならチェックを既定オフ）。 */
  aiEditCount?: number;
  /** 新形式のみ。パネルの「比較元: …」に出す文。 */
  baselineLabel?: string;
  /** 新形式のみ。承認要求にそのまま付けて返す照合キー。 */
  candidateKey?: LearningCandidateKey;
}

/** 新形式の承認を書き出しジョブへ結び付けるキー（書き出し記録の値）。 */
export interface LearningCandidateKey {
  jobId: string;
  documentId: string;
  contentHash: string;
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
  /** 新形式の案件では必須（GET /api/learning/diff の candidateKey をそのまま送る）。 */
  jobId?: string;
  documentId?: string;
  contentHash?: string;
}

/** 学習カテゴリ（承認差分の種類）。 */
export type LearningCategory = 'cut' | 'word' | 'telop' | 'se';

/** 今回の承認で新しく自動ルール化された 1 件（人間向け表示用）。 */
export interface LearningPromotedRule {
  category: LearningCategory;
  /** そのまま画面へ出せる 1 行（例: 「えー」は自動でカットします）。 */
  text: string;
}

/** 今回の承認で学習データへ新しく記録した件数（カット・テロップ・SE は jsonl に増えた行数、語句は辞書に入った件数）。昇格件数とは別物。 */
export interface LearningRecordedCounts {
  cut: number;
  words: number;
  telops: number;
  ses: number;
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
  /**
   * 追加フィールド（後方互換・省略時は全 0 扱い）。
   * 承認して学習データへ記録した件数。上の *Promoted は「閾値に達して自動ルール化された件数」で、
   * 初回承認ではほぼ 0 になるため、人間向け表示にはこちらを使う。
   */
  recorded?: LearningRecordedCounts;
  /**
   * 追加フィールド（後方互換・省略時は空扱い）。
   * 今回新しく自動ルールになった内容。上の *Promoted 件数はルール本数の差分で数えるのに対し、
   * こちらは「前後のルール集合の差」で求めるため、競合で既存ルールが外れた場合に件数と一致しないことがある
   * （画面表示はこの内容リストを正とする）。
   */
  promotedRules?: LearningPromotedRule[];
  /** 送ったが記録済み（ストアの重複照合で弾かれた）ため数えなかった件数（カット・テロップ・SE の合計）。 */
  alreadyRecorded?: number;
  /** スキル側の取り出し台帳（harvest_v2_state.json）を更新できなかった理由。学習の記録自体は成功している。 */
  ledgerError?: string;
}
