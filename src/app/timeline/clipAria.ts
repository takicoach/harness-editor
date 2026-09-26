import { formatClock } from '../../shared/format';

/**
 * クリップの読み上げ名（監査 interaction-10）。
 *
 * クリップは素の div でキーボードから到達できず、`selectedHandle` を立てられないため
 * ←/→ の 1 フレーム微調整に一生たどり着けなかった。Tab で拾えるようにするだけでなく、
 * 「何の・いつの・どれ」が音と AI エージェントの両方に伝わる名前を付ける。
 *
 * 例: `じまく 0:12〜0:15 ゆる素振り`
 *
 * @param kindLabel トラックの日本語名（じまく／テロップ／画像／効果音／BGM／サブ動画／図形）。
 * @param startFrame 原本フレーム（開始）。
 * @param endFrame 原本フレーム（終了）。
 * @param fps 0 以下なら 30 とみなす。
 * @param detail 本文・ファイル名など（空なら付けない）。
 */
export function clipAriaLabel(
  kindLabel: string,
  startFrame: number,
  endFrame: number,
  fps: number,
  detail?: string,
): string {
  const f = fps > 0 ? fps : 30;
  const span = `${formatClock(startFrame / f)}〜${formatClock(endFrame / f)}`;
  const tail = detail !== undefined && detail !== '' ? ` ${detail}` : '';
  return `${kindLabel} ${span}${tail}`;
}

/** Enter / Space をクリップの「選択」として扱うキーか。 */
export function isClipActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * ロービング tabindex（WAI-ARIA APG）のタブ停止となるクリップ id。
 *
 * 全クリップに `tabIndex={0}` を付けていたため、案件 2026-09-04-C0123 では
 * じまく 82＋テロップ 8＋画像 15＋効果音 14…と 120 個超のタブ停止が並び、
 * タイムラインへ Tab で入ると前方へ抜けるのに 100 回超の Tab が要った
 * （サイクル 4 レビュー Important）。トラックごとの停止は 1 個だけにする。
 *
 * 選択中のクリップがそのトラックに居ればそれ、居なければ先頭を停止にする
 * （選択が別トラックに移っても「そのトラックに入る口」は必ず残る）。
 */
export function rovingStopId(ids: number[], selectedId: number | null): number | null {
  if (selectedId !== null && ids.includes(selectedId)) return selectedId;
  return ids[0] ?? null;
}

/** クリップの tabIndex（停止なら 0・それ以外は -1＝プログラム的にはフォーカスできる）。 */
export function rovingTabIndex(id: number, ids: number[], selectedId: number | null): 0 | -1 {
  return rovingStopId(ids, selectedId) === id ? 0 : -1;
}

/** トラック内のクリップ移動の意図。 */
export type ClipNavIntent = 'next' | 'prev' | 'first' | 'last';

/**
 * キーからクリップ移動の意図を引く。
 *
 * APG の水平リストは ←/→ だが、このエディタでは ←/→ は既に
 * 「選択中つまみを 1 フレーム動かす」（spec §8・監査 interaction-10）に割り当て済みで、
 * 奪うと 1 コマ微調整に届かなくなる。そこで移動は ↑/↓ と Home/End に置く。
 */
export function clipNavIntentOf(key: string): ClipNavIntent | null {
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'prev';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  return null;
}

/** 移動先の添字（両端で止まる。count が 0 なら -1）。 */
export function nextClipIndex(count: number, current: number, intent: ClipNavIntent): number {
  if (count <= 0) return -1;
  if (intent === 'first') return 0;
  if (intent === 'last') return count - 1;
  const delta = intent === 'next' ? 1 : -1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/** ロービング移動の対象となるクリップの属性（各トラックがクリップ本体に付ける）。 */
export const CLIP_NAV_ATTR = 'data-clip-nav';

/**
 * 同じトラック内の隣のクリップへフォーカスを移す。
 * 見つからない・移動先が同じなら false（呼び手はキーを既定動作へ返してよい）。
 */
export function focusClipSibling(current: HTMLElement, intent: ClipNavIntent): boolean {
  // トラック行のほか、つなぎ目マーク層（.tl-join-markers）も 1 グループとして扱う。
  const track = current.closest('.tl-track, .tl-join-markers');
  if (track === null) return false;
  const clips = Array.from(track.querySelectorAll<HTMLElement>(`[${CLIP_NAV_ATTR}]`));
  const at = clips.indexOf(current);
  if (at < 0) return false;
  const to = nextClipIndex(clips.length, at, intent);
  const target = clips[to];
  if (target === undefined || target === current) return false;
  target.focus();
  return true;
}

/**
 * クリップの onKeyDown からロービング移動を処理する。
 * 移動キーだったら true（呼び手は preventDefault して打ち切る）。
 */
export function handleClipNavKey(key: string, current: HTMLElement): boolean {
  const intent = clipNavIntentOf(key);
  if (intent === null) return false;
  focusClipSibling(current, intent);
  return true;
}
