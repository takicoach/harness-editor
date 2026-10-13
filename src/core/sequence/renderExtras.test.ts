import { describe, expect, it } from 'vitest';
import { DEFAULT_MAIN_LAYOUT } from '../mainLayout';
import { DEFAULT_TEXT_APPEARANCE, type ClipVisual, type SequenceClip, type SequenceDocument } from './model';
import { textExtrasIssue, visualLookIssue, shapeExtrasIssue } from './renderExtras';
import { validateSequenceDocument } from './validate';

const clock = { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 1, den: 1 } };
const visual = (look?: ClipVisual['look']): ClipVisual => ({ layout: { ...DEFAULT_MAIN_LAYOUT }, opacity: 1, keyframes: [], ...(look ? { look } : {}) });
function documentWith(clips: SequenceClip[]): SequenceDocument {
  return { schemaVersion: 2, id: 'extras', name: '任意項目', revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 }, sequenceEndFrame: 1,
    background: '#000000', assets: [{ id: 'img', kind: 'image', name: 'a.png', file: `.harness/assets/${'a'.repeat(64)}.png`, fingerprint: 'a'.repeat(64), streams: [] }],
    tracks: clips.map(clip => ({ id: clip.trackId, kind: 'visual', name: clip.name, enabled: true })), clips, transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
const text = (appearance = { ...DEFAULT_TEXT_APPEARANCE }): SequenceClip => ({ id: 'text', trackId: 't1', name: '文字', startFrame: 0, durationFrames: 1, clock,
  content: { kind: 'telop', data: { text: 'A' }, appearance, textMode: 'free' } });
const image = (look?: ClipVisual['look']): SequenceClip => ({ id: 'image', trackId: 't2', name: '画像', startFrame: 0, durationFrames: 1, clock,
  content: { kind: 'image', assetId: 'img', style: 'plain' }, visual: visual(look) });
const shape = (extra: Partial<Extract<SequenceClip['content'], { kind: 'shape' }>> = {}): SequenceClip => ({ id: 'shape', trackId: 't3', name: '図形', startFrame: 0, durationFrames: 1, clock,
  content: { kind: 'shape', data: { kind: 'rect', x1: .1, y1: .1, x2: .5, y2: .5, color: '#ff0000', thickness: 'medium' }, ...extra } });

describe('描画の任意項目の検証', () => {
  it('任意項目が無い文書はそのまま通る', () => {
    expect(() => validateSequenceDocument(documentWith([text(), image(), shape()]))).not.toThrow();
  });
  it('全部の任意項目を使った文書が通る', () => {
    const appearance = { ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 8, color: '#000000' }, { width: 6, color: '#ffffff' }],
      shadow: { x: 4, y: 6, blur: 10, color: '#00000099' }, skewDeg: -8, band: { color: '#e60012', padX: 24, padY: 8, radius: 6 }, box: { width: .9, anchor: 'center' as const } };
    const look = { grade: { brightness: 10, contrast: 0, saturation: -100, temperature: 0 }, blur: 4, edge: { width: 12, color: '#ffffff' }, shadow: { x: 0, y: 8, blur: 16, color: '#000000aa' }, flipX: true };
    const fill = { kind: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#000000cc' }, { offset: .7, color: '#00000000' }] };
    expect(() => validateSequenceDocument(documentWith([text(appearance), image(look), shape({ fill, strokeWidth: 0, cornerRadius: 24 })]))).not.toThrow();
  });
  it('縁取りは 2 本まで・色は 16 進だけ', () => {
    expect(textExtrasIssue({ ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 1, color: '#000000' }, { width: 1, color: '#000000' }, { width: 1, color: '#000000' }] })).toBe('文字の縁取りが不正です');
    expect(textExtrasIssue({ ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 1, color: 'red' }] })).toBe('文字の縁取りが不正です');
    expect(() => validateSequenceDocument(documentWith([text({ ...DEFAULT_TEXT_APPEARANCE, skewDeg: 45 })]))).toThrow('文字の傾きが不正です');
  });
  it('文字枠の幅と基準は決まった範囲だけ', () => {
    expect(textExtrasIssue({ ...DEFAULT_TEXT_APPEARANCE, box: { width: 1.5, anchor: 'center' } })).toBe('文字枠が不正です');
    expect(textExtrasIssue({ ...DEFAULT_TEXT_APPEARANCE, box: { width: .5, anchor: 'middle' as 'center' } })).toBe('文字枠が不正です');
  });
  it('look は画像と映像だけ。白フチ・影・反転は画像だけ', () => {
    expect(visualLookIssue(visual({ blur: 2 }), 'telop')).toBe('見た目の追加設定は画像と映像だけに使えます');
    expect(visualLookIssue(visual({ flipX: true }), 'video')).toBe('左右反転が不正です');
    expect(visualLookIssue(visual({ grade: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 } }), 'video')).toBe('映像の色調整は colorGrade を使います');
    expect(() => validateSequenceDocument(documentWith([image({ blur: 99 })]))).toThrow('ぼかしが不正です');
  });
  it('図形のグラデーションは 2〜4 色で位置が昇順', () => {
    const content = shape().content as Extract<SequenceClip['content'], { kind: 'shape' }>;
    expect(shapeExtrasIssue({ ...content, fill: { kind: 'linear', angle: 0, stops: [{ offset: .5, color: '#000000' }, { offset: .2, color: '#ffffff' }] } })).toBe('図形のグラデーションが不正です');
    expect(shapeExtrasIssue({ ...content, strokeWidth: -1 })).toBe('図形の線の太さが不正です');
  });
});
