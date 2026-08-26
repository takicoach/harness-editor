import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import type { ImageSegment } from './types';

interface Props {
  segment: ImageSegment & { imageUrl?: string };
}

type Anim = { kind: 'none' | 'fade' | 'zoom' | 'pop' | 'slideIn'; frames: number; direction?: 'left' | 'right' | 'up' | 'down' };
const FADE: Anim = { kind: 'fade', frames: 8 };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function endpoint(anim: Anim, p: number): { opacity: number; transform: string } {
  const t = clamp(p, 0, 1);
  if (anim.kind === 'none') return { opacity: 1, transform: '' };
  if (anim.kind === 'fade') return { opacity: t, transform: '' };
  if (anim.kind === 'zoom') return { opacity: t, transform: `scale(${Number((0.85 + 0.15 * t).toFixed(4))})` };
  if (anim.kind === 'pop') {
    const s = t < 0.7 ? (t / 0.7) * 1.12 : 1.12 + ((t - 0.7) / 0.3) * (1 - 1.12);
    return { opacity: clamp(t / 0.4, 0, 1), transform: `scale(${Number(s.toFixed(4))})` };
  }
  const dist = (1 - t) * 100;
  const d = anim.direction ?? 'left';
  const tx = d === 'left' ? -dist : d === 'right' ? dist : 0;
  const ty = d === 'up' ? -dist : d === 'down' ? dist : 0;
  return { opacity: t, transform: `translate(${Number(tx.toFixed(4))}%, ${Number(ty.toFixed(4))}%)` };
}

function animStyleAt(frame: number, duration: number, enter: Anim, exit: Anim) {
  if (duration <= 0) return { opacity: 0, transform: '' };
  if (enter.kind !== 'none' && enter.frames > 0 && frame < enter.frames) return endpoint(enter, frame / enter.frames);
  if (exit.kind !== 'none' && exit.frames > 0 && frame > duration - exit.frames) return endpoint(exit, (duration - frame) / exit.frames);
  return { opacity: 1, transform: '' };
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

function clampMotionFull(s: MotionFull): MotionFull {
  return {
    x: clamp(s.x, -1.5, 1.5),
    y: clamp(s.y, -1.5, 1.5),
    scale: clamp(s.scale, 0.05, 8),
    opacity: clamp(s.opacity, 0, 1),
    rotation: clamp(s.rotation, -360, 360),
  };
}

function sampleImageMotion(motion: Motion, base: MotionFull, frame: number, duration: number): MotionFull {
  const k = clamp(motion.intensity ?? 0.5, 0, 1);
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
  const p = duration <= 0 ? 1 : clamp(frame / duration, 0, 1);
  const t = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return clampMotionFull({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  });
}

export function InsertImage({ segment }: Props) {
  const frame = useCurrentFrame();
  const duration = segment.endFrame - segment.startFrame;
  const anim = animStyleAt(frame, duration, (segment.enter as Anim) ?? FADE, (segment.exit as Anim) ?? FADE);
  const src = segment.imageUrl ?? staticFile('images/' + segment.file);
  const baseState: MotionFull = {
    x: segment.position?.x ?? 0,
    y: segment.position?.y ?? 0,
    scale: segment.scale ?? 1,
    opacity: segment.opacity ?? 1,
    rotation: segment.rotation ?? 0,
  };
  const motion = (segment as { motion?: Motion }).motion;
  const sampled = motion ? sampleImageMotion(motion, baseState, frame, duration) : baseState;
  const scale = sampled.scale;
  const pos = { x: sampled.x, y: sampled.y };
  const opacity = sampled.opacity;
  const placement = `translate(${(pos.x * 100) / 2}%, ${(pos.y * 100) / 2}%) rotate(${sampled.rotation}deg) scale(${scale})`;
  if (segment.type === 'overlay') {
    return (
      <AbsoluteFill style={{ opacity: anim.opacity, transform: anim.transform, transformOrigin: '50% 50%' }}>
        <AbsoluteFill style={{ background: 'rgba(0,0,0,0.4)' }} />
        <AbsoluteFill style={{ transform: placement, transformOrigin: '50% 50%', opacity }}>
          <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ opacity: anim.opacity, transform: anim.transform, transformOrigin: '50% 50%' }}>
      <AbsoluteFill style={{ transform: placement, transformOrigin: '50% 50%', opacity, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Img src={src} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
