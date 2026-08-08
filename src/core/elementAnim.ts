import type { ElementAnim } from './types';

/** 既定の出入りアニメ（フェード 8fr）。画像の従来挙動。 */
export const DEFAULT_FADE: ElementAnim = { kind: 'fade', frames: 8 };

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 片端アニメの見た目を進捗 p（0=隠れ／1=表示）で返す。
 * transform は外側ラッパー用（空文字＝変形なし）。
 */
function endpointStyle(anim: ElementAnim, p: number): { opacity: number; transform: string } {
  const t = clamp(p, 0, 1);
  switch (anim.kind) {
    case 'none':
      return { opacity: 1, transform: '' };
    case 'fade':
      return { opacity: t, transform: '' };
    case 'zoom': {
      const scale = 0.85 + 0.15 * t; // 0.85 → 1
      return { opacity: t, transform: `scale(${Number(scale.toFixed(4))})` };
    }
    case 'pop': {
      // 0→1.12（70%地点）→1 のオーバーシュート。不透明度は前半で立ち上げる。
      const scale = t < 0.7 ? (t / 0.7) * 1.12 : 1.12 + ((t - 0.7) / 0.3) * (1 - 1.12);
      return { opacity: clamp(t / 0.4, 0, 1), transform: `scale(${Number(scale.toFixed(4))})` };
    }
    case 'slideIn': {
      const dist = (1 - t) * 100; // % 退避量（100→0）
      const dir = anim.direction ?? 'left';
      const tx = dir === 'left' ? -dist : dir === 'right' ? dist : 0;
      const ty = dir === 'up' ? -dist : dir === 'down' ? dist : 0;
      return { opacity: t, transform: `translate(${Number(tx.toFixed(4))}%, ${Number(ty.toFixed(4))}%)` };
    }
  }
}

/**
 * Sequence 内の相対フレーム frame（0 始まり）における要素の出入り見た目。
 * 登場窓 [0, enter.frames) → 退場窓 (duration-exit.frames, duration] の順で判定し、
 * いずれでもなければ素通し（不透明・無変形）。
 * transform は要素本体 placement を内側に持つ外側ラッパーへ適用する。
 */
export function animStyleAt(
  frame: number,
  durationInFrames: number,
  enter: ElementAnim,
  exit: ElementAnim,
): { opacity: number; transform: string } {
  if (durationInFrames <= 0) return { opacity: 0, transform: '' };
  const enterFrames = Math.max(0, enter.frames);
  const exitFrames = Math.max(0, exit.frames);
  if (enter.kind !== 'none' && enterFrames > 0 && frame < enterFrames) {
    return endpointStyle(enter, frame / enterFrames);
  }
  if (exit.kind !== 'none' && exitFrames > 0 && frame > durationInFrames - exitFrames) {
    return endpointStyle(exit, (durationInFrames - frame) / exitFrames);
  }
  return { opacity: 1, transform: '' };
}
