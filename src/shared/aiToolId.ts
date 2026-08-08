/**
 * AI ツールの識別子。**クライアントとサーバーの両方が読む**ため shared に置く。
 * アダプタ本体（src/server/aiTools.ts）は codexHome 経由で node:fs / node:os を
 * 引くため、ブラウザ側から import すると dev サーバーのバンドルが壊れる。
 * 型・既定値・型ガードだけをここに切り出して共有する。
 */
export type AiToolId = 'claude' | 'codex';

/** 既定は claude（利用者の体験を変えない）。 */
export const DEFAULT_AI_TOOL: AiToolId = 'claude';

/**
 * 許可リストの型ガード。API 境界で必ず通し、未知の文字列が spawn の引数へ
 * 届く経路を作らない。
 */
export function isAiToolId(v: unknown): v is AiToolId {
  return v === 'claude' || v === 'codex';
}
