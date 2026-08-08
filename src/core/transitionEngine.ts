import type { SceneTransition, SceneTransitionKind } from './types';

/** 重なる系か（2 つの場面を重ねる＝再生尺が縮む）。fade 系/none は false。 */
export function isOverlapKind(kind: SceneTransitionKind): boolean {
  return kind === 'crossfade' || kind === 'slide' || kind === 'wipe';
}

/** 再生タイムライン上の重なり。boundary=再生境界フレーム, overlap=重なりフレーム数(>0)。 */
export interface PlaybackOverlap {
  boundary: number;
  overlap: number;
}

/**
 * transitionData（at=再生フレーム）＋区間から overlaps を構築する。
 * 重なる系のみ・境界一致のみ。overlap は隣接区間の短い方の半分でクランプ（唯一の権威）。
 */
export function buildOverlaps(
  transitions: SceneTransition[],
  segments: Array<{ playbackStart: number; playbackEnd: number }>,
): PlaybackOverlap[] {
  const out: PlaybackOverlap[] = [];
  for (const t of transitions) {
    if (typeof t.at !== 'number') continue;
    if (!isOverlapKind(t.kind)) continue;
    const i = segments.findIndex((s) => s.playbackEnd === t.at);
    if (i < 0 || i + 1 >= segments.length) continue;
    const prev = segments[i]!;
    const next = segments[i + 1]!;
    const lenPrev = prev.playbackEnd - prev.playbackStart;
    const lenNext = next.playbackEnd - next.playbackStart;
    const cap = Math.floor(Math.min(lenPrev, lenNext) / 2);
    // durationFrames を整数フレームへ丸めてから上限（隣接区間の短い方の半分）でクランプ。
    // 上流が整数フレーム保証なら round は無害。同一 at の多重転換は editState 側で発生しない（at をキーに置換）。
    const overlap = Math.min(Math.max(0, Math.round(t.durationFrames)), cap);
    if (overlap <= 0) continue;
    out.push({ boundary: t.at, overlap });
  }
  out.sort((a, b) => a.boundary - b.boundary);
  return out;
}

/** 重なり補正後の最終総フレーム数。 */
export function finalTotalFrames(playbackTotal: number, overlaps: PlaybackOverlap[]): number {
  const sum = overlaps.reduce((s, o) => s + o.overlap, 0);
  return Math.max(0, playbackTotal - sum);
}

/** 再生フレーム→最終フレーム（境界以後を前へ詰める）。 */
export function playbackToFinal(playbackFrame: number, overlaps: PlaybackOverlap[]): number {
  let shift = 0;
  for (const o of overlaps) {
    if (playbackFrame >= o.boundary) shift += o.overlap;
  }
  return playbackFrame - shift;
}

/**
 * 最終フレーム→再生フレーム（逆射影）。重なり窓の外では playbackToFinal の逆。
 * 窓内は A 側（先行区間）として扱う＝一意でないが再生ヘッドは単調に動く。
 * overlaps の順序は問わない（内部で boundary 昇順にソートして処理する）。
 * 注: playbackToFinal は順不同で等価だが、こちらは累積 cum を使うため昇順ソートが必須。
 */
export function finalToPlayback(finalFrame: number, overlaps: PlaybackOverlap[]): number {
  const sorted = [...overlaps].sort((a, b) => a.boundary - b.boundary);
  let p = finalFrame;
  let cum = 0;
  for (const o of sorted) {
    const finalABoundary = o.boundary - cum; // A 側境界の最終位置
    if (finalFrame >= finalABoundary) {
      p += o.overlap;
      cum += o.overlap;
    }
  }
  return p;
}
