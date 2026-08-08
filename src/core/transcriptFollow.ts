import type { EditorTelop } from './types';

/** 文字起こしパネルの「再生ヘッド追従」トグル状態の永続キー。 */
export const TRANSCRIPT_FOLLOW_STORAGE_KEY = 'sme.tx.follow-enabled';

/**
 * localStorage の保存値から初期トグル状態を決める。
 * 既定は ON（未保存・null・不正値はすべて true）。明示的に 'false' が保存されているときのみ OFF。
 */
export function resolveInitialFollowEnabled(stored: string | null): boolean {
  return stored !== 'false';
}

/**
 * 原本フレーム frame を含む（originalStart<=frame<originalEnd）テロップの id を返す。
 * 該当が無ければ null（`core/segmentOps.ts` の `telopAtFrame` と同じ半開区間規約）。
 */
export function followedTelopId(
  telops: Pick<EditorTelop, 'id' | 'originalStart' | 'originalEnd'>[],
  frame: number,
): number | null {
  const hit = telops.find((t) => t.originalStart <= frame && frame < t.originalEnd);
  return hit ? hit.id : null;
}

/** 手動スクロール検知後、自動追従を一時停止する長さ（ミリ秒）。 */
export const MANUAL_SCROLL_PAUSE_MS = 1500;

/**
 * 再生ヘッド追従スクロールを実行してよいかを判定する。
 * トグル ON・再生中・かつ手動スクロールの一時停止明け、の3条件すべてを満たす必要がある
 * （Timeline の追従スクロールと同じ「再生中のみ追従」規律に、手動スクロール尊重を追加）。
 */
export function shouldAutoFollow(params: {
  enabled: boolean;
  isPlaying: boolean;
  now: number;
  pausedUntil: number;
}): boolean {
  return params.enabled && params.isPlaying && params.now >= params.pausedUntil;
}
