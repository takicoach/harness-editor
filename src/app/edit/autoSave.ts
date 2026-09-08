/**
 * 自動保存（debounce）の純ロジック。
 * dirty になってから一定時間操作が落ち着いたら保存する、その発火可否判定だけを担う。
 * タイマー・DOM フォーカス取得は呼び出し側（useAutoSave フック）が行う。
 */

/** dirty から保存発火までの静止時間（ミリ秒）。 */
export const AUTO_SAVE_DELAY_MS = 4000;

/**
 * テキスト編集中を理由に自動保存を先送りできる回数の上限。
 * これを超えたら、フォーカスが入力欄に残っていても保存する（監査 data-safety-10）。
 * 以前は上限が無く、字幕欄にカーソルを残したまま手を止めると永久に未保存で残っていた。
 */
export const MAX_AUTO_SAVE_DEFERRALS = 3;

export type AutoSaveStatus = 'idle' | 'saving' | 'error';

export interface AutoSaveDecisionInput {
  /** 自動保存トグルが ON か。 */
  enabled: boolean;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  /** 現在の保存処理状態。'saving' 中の重複起動・'error' 後の自動再試行を防ぐために使う。 */
  saveStatus: AutoSaveStatus;
  /** フォーカスが input/textarea/contentEditable にあるか（テキスト編集中の割込み防止）。 */
  focusInEditable: boolean;
}

/**
 * 今この瞬間に自動保存を発火してよいか判定する。
 * - トグル OFF なら発火しない
 * - dirty でなければ保存不要（発火しない）
 * - 'saving' 中（二重起動防止）・'error' 後（自動リトライしない）は発火しない
 * - テキスト編集中（フォーカスが input/textarea/contentEditable）は発火しない（呼び出し側が再スケジュールする）
 */
export function shouldFireAutoSave(input: AutoSaveDecisionInput): boolean {
  if (!input.enabled) return false;
  if (!input.dirty) return false;
  if (input.saveStatus !== 'idle') return false;
  if (input.focusInEditable) return false;
  return true;
}

/**
 * テキスト編集中の先送りを打ち切って保存すべきか。
 * IME 変換中は文字が確定していないため、上限に達していても打ち切らない
 *（変換中の割り込み保存は入力を壊しかねない）。
 */
export function shouldForceAutoSave(deferrals: number, composing: boolean): boolean {
  if (composing) return false;
  return deferrals >= MAX_AUTO_SAVE_DEFERRALS;
}

/**
 * URL クエリ `autoSaveDelayMsForTest` から自動保存の待ち時間上書き値を読む。
 * e2e の待ち時間短縮専用（本番導線は使わない）。正の数値以外（未設定・0以下・非数値）は
 * null を返し、呼び出し側は既定の AUTO_SAVE_DELAY_MS を使う。
 */
export function parseAutoSaveDelayOverride(search: string): number | null {
  const params = new URLSearchParams(search);
  const raw = params.get('autoSaveDelayMsForTest');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
