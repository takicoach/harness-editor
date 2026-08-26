/**
 * プロジェクト状態ドメインの唯一の正本（Codex レビュー P1「stage スキーマ衝突」対応）。
 * サーバ検証（projectStatus.ts）・カンバン列（homeKanban.ts）・ラベル/CSS
 * （projectStatusView.ts）はすべてここから派生させる。手同期の「正本3箇所」は廃止。
 */

/**
 * 表示ステータス6値。編集工程順（カンバン列の並び順もこの順）。
 * 工程ステッパー（ProjectSteps）と同じ工程名を使い、自動判定は「最初の未完了工程」を指す。
 * 旧5値の 'editing' / 'review' / 'published' は廃止（実運用で機能していなかったため）。
 * 旧値が書かれた `.sme/status.json` は parseProjectStage が未知値 → null（自動判定）へ落とす。
 */
export const DISPLAY_STATUSES = [
  'idle',
  'transcribe',
  'cut',
  'telop',
  'audio',
  'rendered',
] as const;

export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/** `.sme/status.json` の手動 stage。null は自動判定に委ねる。 */
export type ProjectStage = DisplayStatus | null;

/** 表示ステータス → 日本語ラベル。 */
export const STATUS_LABEL: Record<DisplayStatus, string> = {
  idle: '未着手',
  transcribe: '文字起こし',
  cut: 'カット',
  telop: 'テロップ',
  audio: 'SE・BGM',
  rendered: '書き出し済',
};

export function isDisplayStatus(v: unknown): v is DisplayStatus {
  return typeof v === 'string' && (DISPLAY_STATUSES as readonly string[]).includes(v);
}

/** unknown を検証して ProjectStage へ。不正・未知値は null（自動判定フォールバック）。 */
export function parseProjectStage(value: unknown): ProjectStage {
  return isDisplayStatus(value) ? value : null;
}

/** 表示ステータス → 色分け CSS クラス。 */
export function statusColorClass(s: DisplayStatus): string {
  return `status-${s}`;
}
