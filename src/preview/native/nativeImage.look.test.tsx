import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { colorGradeMatrixValues } from '../../core/colorGrade';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { VisualLook } from '../../core/sequence/model';
import type { PlannedVisual } from '../../core/sequence/scenePlan';
import { NativeImage } from './NativeImage';

const visual = (look?: VisualLook): PlannedVisual => ({
  clip: { id: 'img', trackId: 't', name: '画像', startFrame: 0, durationFrames: 1, clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 1, den: 1 } },
    content: { kind: 'image', assetId: 'a', style: 'plain' },
    visual: { layout: { ...DEFAULT_MAIN_LAYOUT, scale: .5 }, opacity: 1, keyframes: [], enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 }, ...(look ? { look } : {}) } },
  effectFrame: 0, effectDuration: 1, transform: { x: 0, y: 0, scale: .5, rotation: 0, opacity: 1, flipH: false, flipV: false } });
const draw = (look?: VisualLook) => renderToStaticMarkup(<NativeImage visual={visual(look)} src="/a.png" />);

describe('画像の任意項目', () => {
  it('任意項目が無いと従来どおり（フィルター無し・反転無し）', () => {
    const html = draw();
    expect(html).not.toContain('<svg');
    expect(html).toContain('filter:opacity(1)');
    expect(html).not.toContain('scaleX(-1)');
  });
  it('色調整・ぼかし・白フチは 1 つの SVG フィルター、影は外側、反転は画像要素', () => {
    const grade = { brightness: 0, contrast: 0, saturation: -100, temperature: 0 };
    const html = draw({ grade, blur: 3, edge: { width: 12, color: '#ffffff' }, shadow: { x: 0, y: 8, blur: 16, color: '#000000aa' }, flipX: true });
    expect(html).toContain('<filter id="native-look-img"');
    expect(html).toContain(`values="${colorGradeMatrixValues(grade)}"`);
    expect(html).toContain('stdDeviation="3"');
    expect(html).toContain('radius="12"');
    expect(html).toContain('flood-color="#ffffff"');
    expect(html).toContain('filter:url(#native-look-img)');
    expect(html).toContain('transform:scaleX(-1)');
    expect(html).toContain('filter:drop-shadow(0px 8px 16px #000000aa)');
  });
  it('ぼかしだけなら CSS の blur', () => {
    const html = draw({ blur: 5 });
    expect(html).not.toContain('<filter');
    expect(html).toContain('filter:blur(5px)');
  });
});
