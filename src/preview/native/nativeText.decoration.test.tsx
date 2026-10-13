import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaptureFrameProvider } from '../../captureRuntime';
import { DEFAULT_TEXT_APPEARANCE, type TextAppearance } from '../../core/sequence/model';
import { NativeText } from './NativeText';

const draw = (appearance: TextAppearance): string => renderToStaticMarkup(
  <CaptureFrameProvider frame={0} videoConfig={{ width: 1280, height: 720, fps: 30, durationInFrames: 1 }}>
    <NativeText segment={{ id: 1, startFrame: 0, endFrame: 1, text: 'サムネ', animation: 'none' }} appearance={appearance} />
  </CaptureFrameProvider>);

describe('NativeText の任意項目', () => {
  it('任意項目が無いと従来の DOM のまま', () => {
    const html = draw({ ...DEFAULT_TEXT_APPEARANCE });
    expect(html).not.toContain('data-native-text-glyphs');
    expect(html).toContain('padding:8px 16px');
    expect(html).toContain('left:7.5%;width:85%');
    expect(html).toContain('transform:translate(0px,0px)');
  });
  it('2 重の縁取りは外側の線を先に重ね、塗りは線なしで上に置く', () => {
    const html = draw({ ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 6, color: '#000000' }, { width: 10, color: '#ffffff' }] });
    expect(html.match(/data-native-text-outline/g)).toHaveLength(2);
    expect(html.indexOf('-webkit-text-stroke:32px #ffffff')).toBeLessThan(html.indexOf('-webkit-text-stroke:12px #000000'));
    expect(html).toContain('-webkit-text-stroke:0px transparent');
  });
  it('帯・傾き・影・中央基準の文字枠', () => {
    const html = draw({ ...DEFAULT_TEXT_APPEARANCE, band: { color: '#e60012', padX: 30, padY: 10, radius: 12 }, skewDeg: 8,
      shadow: { x: 4, y: 6, blur: 8, color: '#00000099' }, box: { width: .5, anchor: 'center' } });
    expect(html).toContain('padding:10px 30px');
    expect(html).toContain('background:#e60012');
    expect(html).toContain('border-radius:12px');
    expect(html).toContain('transform:skewX(-8deg)');
    expect(html).toContain('filter:drop-shadow(4px 6px 8px #00000099)');
    expect(html).toContain('left:25%;width:50%;top:50%');
    expect(html).toContain('transform:translate(0px,calc(0px - 50%))');
  });
  it('上揃えの文字枠は位置を枠の上端にする（中央寄せの translateY を掛けない）', () => {
    const html = draw({ ...DEFAULT_TEXT_APPEARANCE, box: { width: .5, anchor: 'top' } });
    expect(html).toContain('top:50%');
    expect(html).not.toContain('-50%');
  });
  it('強調語は emphasis があるときだけ解釈する。無ければ ** は文字のまま', () => {
    const marked = (appearance: TextAppearance) => renderToStaticMarkup(
      <CaptureFrameProvider frame={0} videoConfig={{ width: 1280, height: 720, fps: 30, durationInFrames: 1 }}>
        <NativeText segment={{ id: 1, startFrame: 0, endFrame: 1, text: '左手から**握る**のが基本', animation: 'none' }} appearance={appearance} />
      </CaptureFrameProvider>);
    expect(marked({ ...DEFAULT_TEXT_APPEARANCE })).toContain('左手から**握る**のが基本');
    const html = marked({ ...DEFAULT_TEXT_APPEARANCE, emphasis: { color: '#d6a93a' } });
    expect(html).toContain('data-native-text-emphasis');
    expect(html).toContain('color:#d6a93a');
    expect(html).not.toContain('**');
  });
});
