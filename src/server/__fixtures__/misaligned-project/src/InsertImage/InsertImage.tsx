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

export function InsertImage({ segment }: Props) {
  const frame = useCurrentFrame();
  const duration = segment.endFrame - segment.startFrame;
  const anim = animStyleAt(frame, duration, (segment.enter as Anim) ?? FADE, (segment.exit as Anim) ?? FADE);
  const src = segment.imageUrl ?? staticFile('images/' + segment.file);
  const scale = segment.scale ?? 1;
  const pos = segment.position ?? { x: 0, y: 0 };
  const opacity = segment.opacity ?? 1;
  const placement = `translate(${(pos.x * 100) / 2}%, ${(pos.y * 100) / 2}%) rotate(${segment.rotation ?? 0}deg) scale(${scale})`;
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
