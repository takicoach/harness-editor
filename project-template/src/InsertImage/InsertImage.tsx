import React from 'react';
import { useCurrentFrame, interpolate, Img, staticFile } from 'remotion';
import type { ImageSegment } from './types';

interface InsertImageProps {
  segment: ImageSegment & { imageUrl?: string };
}


// ── 2点アニメ（Harness Editor の core/motion.ts と同式・自己完結） ──
type MotionState = { x?: number; y?: number; scale?: number; opacity?: number; rotation?: number };
type Motion = {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom';
  intensity?: number;
  from?: MotionState;
  to?: MotionState;
};
type MotionFull = { x: number; y: number; scale: number; opacity: number; rotation: number };
const mclamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function clampMotionFull(s: MotionFull): MotionFull {
  return {
    x: mclamp(s.x, -1.5, 1.5),
    y: mclamp(s.y, -1.5, 1.5),
    scale: mclamp(s.scale, 0.05, 8),
    opacity: mclamp(s.opacity, 0, 1),
    rotation: mclamp(s.rotation, -360, 360),
  };
}

function sampleImageMotion(motion: Motion, base: MotionFull, frame: number, duration: number): MotionFull {
  const k = mclamp(motion.intensity ?? 0.5, 0, 1);
  let from: MotionFull = { ...base };
  let to: MotionFull = { ...base };
  if (motion.preset === 'zoomIn') to = { ...to, scale: base.scale * (1 + 0.8 * k) };
  if (motion.preset === 'zoomOut') from = { ...from, scale: base.scale * (1 + 0.8 * k) };
  if (motion.preset === 'panLeft') { from = { ...from, x: base.x + 0.4 * k }; to = { ...to, x: base.x - 0.4 * k }; }
  if (motion.preset === 'panRight') { from = { ...from, x: base.x - 0.4 * k }; to = { ...to, x: base.x + 0.4 * k }; }
  if (motion.preset === 'fadeIn') from = { ...from, opacity: 0 };
  const apply = (target: MotionFull, o: MotionState | undefined): MotionFull => ({
    x: o?.x ?? target.x, y: o?.y ?? target.y, scale: o?.scale ?? target.scale,
    opacity: o?.opacity ?? target.opacity, rotation: o?.rotation ?? target.rotation,
  });
  from = clampMotionFull(apply(from, motion.from));
  to = clampMotionFull(apply(to, motion.to));
  const p = duration <= 0 ? 1 : mclamp(frame / duration, 0, 1);
  const t = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return clampMotionFull({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  });
}

export const InsertImage: React.FC<InsertImageProps> = ({ segment }) => {
  const frame = useCurrentFrame();
  const duration = segment.endFrame - segment.startFrame;
  // ImageSequence が <Sequence from={startFrame}> でラップするため useCurrentFrame は
  // 区間先頭=0 の相対フレーム。ここで startFrame を引くと二重減算で負になりフェードが
  // 0 にクランプ＝画像が透明になる。相対フレームをそのまま localFrame として使う。
  const localFrame = frame;
  // src は editor プレビューでは segment.imageUrl、最終 render では staticFile。
  const src = segment.imageUrl ?? staticFile(`images/${segment.file}`);

  const fade = interpolate(
    localFrame,
    [0, 8, duration - 8, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  // ユーザー配置＋2点アニメ: motion があれば区間の進行度で位置/大きさ/不透明度/回転を補間する。
  const baseState: MotionFull = {
    x: segment.position?.x ?? 0,
    y: segment.position?.y ?? 0,
    scale: segment.scale ?? 1,
    opacity: segment.opacity ?? 1,
    rotation: segment.rotation ?? 0,
  };
  const motion = (segment as { motion?: Motion }).motion;
  const sampled = motion ? sampleImageMotion(motion, baseState, localFrame, duration) : baseState;
  // ユーザー不透明度（補間済み）をフェードに乗算。暗幕には掛けない。
  const opacity = fade * sampled.opacity;
  const pos = { x: sampled.x, y: sampled.y };
  const userScale = sampled.scale;
  const placement = `translate(${(pos.x * 100) / 2}%, ${(pos.y * 100) / 2}%) rotate(${sampled.rotation}deg) scale(${userScale})`;

  // 写真は内側で Ken Burns（ゆっくり拡大）。
  const kenBurns = segment.type === 'photo'
    ? interpolate(localFrame, [0, duration], [1.0, 1.05], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  return (
    <>
      {/* overlay の暗幕は配置レイヤーの外＝全画面・背面（画像と一緒に動かない）。 */}
      {segment.type === 'overlay' && (
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            opacity: fade,
            zIndex: 50,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: 0, left: 0, width: '100%', height: '100%',
          transform: placement,
          transformOrigin: '50% 50%',
          opacity,
          zIndex: 50,
          display: segment.type === 'overlay' ? 'flex' : 'block',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {segment.type === 'overlay' ? (
          <Img src={src} style={{ maxWidth: '80%', maxHeight: '80%', objectFit: 'contain' }} />
        ) : (
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: segment.type === 'infographic' ? 'contain' : 'cover',
              transform: `scale(${kenBurns})`,
            }}
          />
        )}
      </div>
    </>
  );
};
