import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaptureFrameProvider } from '../../captureRuntime';
import { DEFAULT_TEXT_APPEARANCE } from '../../core/sequence/model';
import type { TelopSegment } from '../../core/types';
import { NativeText } from './NativeText';

const draw = (animation: TelopSegment['animation'], frame: number, text = 'あたらしい動き'): string =>
  renderToStaticMarkup(
    <CaptureFrameProvider frame={frame} videoConfig={{ width: 1920, height: 1080, fps: 30, durationInFrames: 300 }}>
      <NativeText segment={{ id: 1, startFrame: 10, endFrame: 70, text, animation }} appearance={{ ...DEFAULT_TEXT_APPEARANCE }} />
    </CaptureFrameProvider>);

describe('自由な書式の新 8 種', () => {
  it('既存 9 種は印を出さない（従来の式のまま）', () => {
    for (const animation of ['none', 'fadeOnly', 'slideIn', 'charByChar', 'slideFromLeft'] as const) {
      const html = draw(animation, 13);
      expect(html, animation).not.toContain('data-native-text-band');
      expect(html, animation).not.toContain('data-native-text-underline');
      expect(html, animation).not.toContain('data-native-text-cursor');
    }
  });

  it('popIn は文字ボックスに scale が乗り、外枠の不透明度は退場だけになる', () => {
    const html = draw('popIn', 10);
    expect(html).toMatch(/data-native-text-box[^>]*style="[^"]*transform:scale\(0\.3\)/);
    // 入場の共通 opacity（Math.min(enter,exit)）は重ねない＝外枠は 1
    expect(html).toMatch(/data-native-text[^-][^>]*style="[^"]*opacity:1/);
  });

  it('退場は 8 フレームのフェードだけ（30fps）', () => {
    expect(draw('popIn', 66)).toMatch(/data-native-text[^-][^>]*style="[^"]*opacity:0\.5/);
    expect(draw('popIn', 70)).toMatch(/data-native-text[^-][^>]*style="[^"]*opacity:0/);
  });

  it('wipeReveal は clip-path、blurOutFocus は filter を文字ボックスに当てる', () => {
    expect(draw('wipeReveal', 10)).toMatch(/data-native-text-box[^>]*style="[^"]*clip-path:inset\(0 100% 0 0\)/);
    expect(draw('blurOutFocus', 10)).toMatch(/data-native-text-box[^>]*style="[^"]*filter:blur\(/);
  });

  it('typeCursor は文字が増え、出切ったらカーソルが消える', () => {
    expect(draw('typeCursor', 10)).toContain('data-native-text-cursor');
    expect(draw('typeCursor', 30)).toContain('あたらしい動き');
    expect(draw('typeCursor', 30)).not.toContain('data-native-text-cursor');
  });

  it('bandLeadsText は帯、underlineGrow は下線を文字の兄弟として出す', () => {
    expect(draw('bandLeadsText', 13)).toMatch(/data-native-text-band[^>]*style="[^"]*width:/);
    expect(draw('underlineGrow', 13)).toMatch(/data-native-text-underline[^>]*style="[^"]*background:#facc15/);
  });

  it('尺が 0 以下なら何も描かない（既存の規則を保つ）', () => {
    expect(renderToStaticMarkup(
      <CaptureFrameProvider frame={10} videoConfig={{ width: 1920, height: 1080, fps: 30, durationInFrames: 300 }}>
        <NativeText segment={{ id: 1, startFrame: 10, endFrame: 10, text: 'x', animation: 'popIn' }} appearance={{ ...DEFAULT_TEXT_APPEARANCE }} />
      </CaptureFrameProvider>)).toBe('');
  });
});
