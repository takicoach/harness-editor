import { nextPlaybackRate, type TransportKey } from '../preview/transport';

export interface ShuttleState { rate: number; playing: boolean; kHeld: boolean }
export type ShuttleAction =
  | { kind: 'play'; rate: number }
  | { kind: 'pause' }
  | { kind: 'step'; delta: -1 | 1 };

/** Shift+J/L のスロー再生。|rate| < 1 は audioPlaybackPlan が無音で扱う（逆再生と同じ経路）。 */
export const SLOW_RATE = 0.5;

/**
 * J/K/L の押下をトランスポート操作へ変換する（一般的な動画編集ソフトの慣習）。
 * - K 押しっぱなし中の J/L は 1 コマ送り
 * - Shift+J/L はスロー（±0.5）。連打では加速しない
 * - J/L は transport.ts の段（1→2→4→8）。停止中・スロー中からは等速で入る
 * - maxRate（設定「J / L 連打の最高速度」）で頭打ちにする。MONITOR_RATES の段に載る 4 / 8 だけを受ける
 *   （任意の number を許すと validatePlaybackRate が throw する値を作れてしまう）
 */
export function shuttleAction(state: ShuttleState, key: TransportKey, shift: boolean, maxRate: 4 | 8 = 8): ShuttleAction {
  if (key === 'k') return { kind: 'pause' };
  const dir = key === 'l' ? 1 : -1;
  if (state.kHeld) return { kind: 'step', delta: dir };
  if (shift) return { kind: 'play', rate: dir * SLOW_RATE };
  const current = state.playing && Math.abs(state.rate) >= 1 ? state.rate : 0;
  const next = nextPlaybackRate(current, key);
  return { kind: 'play', rate: Math.sign(next) * Math.min(Math.abs(next), maxRate) };
}

export interface ShuttlePlayer { stop(): void; seekBy(delta: number): unknown; shuttle(key: 'j' | 'l', shift: boolean, maxRate?: 4 | 8): void }
export interface ShuttleKeyState { kHeld: boolean }
export interface ShuttleKeyEvent { key: string; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }

/**
 * ワークスペースの keydown から J/K/L を player へ振り分ける。戻り値 true = 処理済み（preventDefault 済み）。
 * - 修飾キー付き（⌘K の分割など）は扱わない（false）
 * - K: 初回押下で stop、押しっぱなし（repeat）は無視、以後 keyup まで kHeld
 * - K 押下中の J/L: stop して 1 コマ送り
 * - J/L: player.shuttle（repeat は無視）
 */
export function shuttleKeyDown(event: ShuttleKeyEvent, state: ShuttleKeyState, player: ShuttlePlayer | null, maxRate?: 4 | 8): boolean {
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey || (key !== 'j' && key !== 'k' && key !== 'l')) return false;
  event.preventDefault();
  if (key === 'k') { if (!event.repeat) { state.kHeld = true; player?.stop(); } return true; }
  if (event.repeat) return true;
  if (state.kHeld) { player?.stop(); void player?.seekBy(key === 'l' ? 1 : -1); return true; }
  player?.shuttle(key, event.shiftKey, maxRate);
  return true;
}
export function shuttleKeyUp(event: { key: string }, state: ShuttleKeyState): void { if (event.key.toLowerCase() === 'k') state.kHeld = false; }
export function shuttleBlur(state: ShuttleKeyState): void { state.kHeld = false; }
