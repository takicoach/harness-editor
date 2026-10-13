import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { ShapeFill } from '../../core/sequence/model';
import type { PlannedVisual } from '../../core/sequence/scenePlan';
import { NativeShape } from './NativeShape';

const visual = (extra: { fill?: ShapeFill; strokeWidth?: number; cornerRadius?: number } = {}): PlannedVisual => ({
  clip: { id: 's1', trackId: 't', name: '図形', startFrame: 0, durationFrames: 1, clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 1, den: 1 } },
    content: { kind: 'shape', data: { kind: 'rect', x1: .1, y1: .1, x2: .5, y2: .5, color: '#ff0000', thickness: 'medium' }, ...extra },
    visual: { layout: { ...DEFAULT_MAIN_LAYOUT }, opacity: 1, keyframes: [], enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 } } },
  effectFrame: 0, effectDuration: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false } });
const draw = (extra?: Parameters<typeof visual>[0]) => renderToStaticMarkup(<NativeShape visual={visual(extra)} width={1280} height={720} />);

describe('図形の任意項目', () => {
  it('任意項目が無いと従来どおり線だけ', () => {
    const html = draw();
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="#ff0000"');
    expect(html).toContain('stroke-width="7"');
    expect(html).not.toContain('rx=');
    expect(html).not.toContain('linearGradient');
  });
  it('単色の塗り・角丸・線なし', () => {
    const html = draw({ fill: { kind: 'solid', color: '#00ff00' }, cornerRadius: 24, strokeWidth: 0 });
    expect(html).toContain('fill="#00ff00"');
    expect(html).toContain('rx="24"');
    expect(html).toContain('stroke="none"');
  });
  it('線形グラデーションは defs に置いて参照する', () => {
    const html = draw({ fill: { kind: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000cc' }, { offset: .65, color: '#00000000' }] }, strokeWidth: 12 });
    expect(html).toContain('<linearGradient id="native-fill-s1" gradientTransform="rotate(90 .5 .5)">');
    expect(html).toContain('stop-color="#000000cc"');
    expect(html).toContain('fill="url(#native-fill-s1)"');
    expect(html).toContain('stroke-width="12"');
  });
});
