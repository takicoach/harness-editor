import { describe, it, expect } from 'vitest';
import {
  RENDER_PRESETS,
  DEFAULT_RENDER_OPTIONS,
  renderExtraArgs,
  postScaleArgs,
  renderOutputName,
  parseRenderOptions,
  matchPreset,
  presetLabel,
  resolutionLabel,
} from './renderPreset';

describe('renderExtraArgs', () => {
  it('full は中間 CRF 14＋1.5 倍SSをh264-mkv/PCMで生成する', () => {
    expect(renderExtraArgs({ resolution: 'full', quality: 'high' }))
      .toEqual(['--crf', '14', '--scale', '1.5', '--codec', 'h264-mkv', '--audio-codec', 'pcm-16', '--image-format', 'png', '--color-space', 'bt709']);
  });
  it('720p も中間は 1.5 倍 SS（縮小は仕上げ側で 4/9）', () => {
    expect(renderExtraArgs({ resolution: '720p', quality: 'light' }))
      .toEqual(['--crf', '14', '--scale', '1.5', '--codec', 'h264-mkv', '--audio-codec', 'pcm-16', '--image-format', 'png', '--color-space', 'bt709']);
  });
  it('品質は中間引数に影響しない（最終 CRF は postScaleArgs 側）', () => {
    expect(renderExtraArgs({ resolution: 'full', quality: 'standard' }))
      .toEqual(['--crf', '14', '--scale', '1.5', '--codec', 'h264-mkv', '--audio-codec', 'pcm-16', '--image-format', 'png', '--color-space', 'bt709']);
  });
});

describe('postScaleArgs', () => {
  const HD = { width: 1920, height: 1080 };
  it('最終解像度へ lanczos 縮小＋品質別 CRF＋音声コピー', () => {
    const args = postScaleArgs({ resolution: 'full', quality: 'high' }, 'in.mp4', 'out.mp4', HD);
    expect(args).toContain('in.mp4');
    expect(args[args.length - 1]).toBe('out.mp4');
    // 中間は 1.5 倍で描かれているので、等倍出力でも縮小が入る。
    expect(args.join(' ')).toContain('scale=1920:1080:flags=lanczos');
    expect(args.join(' ')).toContain('-crf 18');
    expect(args.join(' ')).toContain('-c:a copy');
  });
  it('quality light は最終 CRF 24、standard は 23', () => {
    expect(postScaleArgs({ resolution: '720p', quality: 'light' }, 'a', 'b', HD).join(' ')).toContain('-crf 24');
    expect(postScaleArgs({ resolution: 'full', quality: 'standard' }, 'a', 'b', HD).join(' ')).toContain('-crf 23');
  });
  it('720p は 2/3 縮小の実解像度で指定する', () => {
    expect(postScaleArgs({ resolution: '720p', quality: 'light' }, 'a', 'b', HD).join(' '))
      .toContain('scale=1280:720:flags=lanczos');
  });
  it('4K 素材の 1080p は 1920×1080 になる', () => {
    expect(postScaleArgs({ resolution: '1080p', quality: 'high' }, 'a', 'b', { width: 3840, height: 2160 }).join(' '))
      .toContain('scale=1920:1080:flags=lanczos');
  });
  it('RemotionのPCM中間だけ最終AACへ一度encodeし、既存呼出はcopyを維持する', () => {
    expect(postScaleArgs({ resolution: 'full', quality: 'high' }, 'in.mkv', 'out.mp4', HD, 'aac').join(' '))
      .toContain('-c:a aac');
    expect(postScaleArgs({ resolution: 'full', quality: 'high' }, 'in.mkv', 'out.mp4', HD, 'aac').join(' '))
      .toContain('-b:a 320k');
    expect(postScaleArgs({ resolution: 'full', quality: 'high' }, 'in.mp4', 'out.mp4', HD).join(' '))
      .toContain('-c:a copy');
    expect(postScaleArgs({ resolution: 'full', quality: 'high' }, 'in.mp4', 'out.mp4', HD).join(' '))
      .not.toContain('-b:a');
  });
  it('RGBからBT.709へ変換済みのRemotion中間だけ最終MP4へ色情報を明示する', () => {
    const remotion = postScaleArgs({ resolution: '720p', quality: 'high' }, 'in.mkv', 'out.mp4', HD, 'aac');
    expect(remotion[remotion.indexOf('-vf') + 1]).toBe('scale=1280:720:flags=lanczos,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
    for (const flag of ['-colorspace', '-color_primaries', '-color_trc']) {
      expect(remotion[remotion.indexOf(flag) + 1]).toBe('bt709');
    }
    expect(remotion[remotion.indexOf('-color_range') + 1]).toBe('tv');
    const native = postScaleArgs({ resolution: '720p', quality: 'high' }, 'in.mp4', 'out.mp4', HD);
    for (const flag of ['-colorspace', '-color_primaries', '-color_trc', '-color_range']) {
      expect(native).not.toContain(flag);
    }
  });
});

describe('renderOutputName', () => {
  it('full は video.mp4、縮小版は解像度つきの名前', () => {
    expect(renderOutputName({ resolution: 'full', quality: 'high' })).toBe('video.mp4');
    expect(renderOutputName({ resolution: '720p', quality: 'high' })).toBe('video-720p.mp4');
    expect(renderOutputName({ resolution: '1080p', quality: 'high' })).toBe('video-1080p.mp4');
  });
});

describe('parseRenderOptions', () => {
  it('undefined / 空オブジェクトは既定値（後方互換）', () => {
    expect(parseRenderOptions(undefined)).toEqual(DEFAULT_RENDER_OPTIONS);
    expect(parseRenderOptions(null)).toEqual(DEFAULT_RENDER_OPTIONS);
    expect(parseRenderOptions({})).toEqual(DEFAULT_RENDER_OPTIONS);
  });
  it('正しい値はそのまま返す', () => {
    expect(parseRenderOptions({ resolution: '720p', quality: 'light' }))
      .toEqual({ resolution: '720p', quality: 'light' });
  });
  it('不正値は null', () => {
    expect(parseRenderOptions({ resolution: '4k', quality: 'high' })).toBeNull();
    expect(parseRenderOptions({ resolution: 'full', quality: 'ultra' })).toBeNull();
    expect(parseRenderOptions({ resolution: 'full' })).toBeNull();
    expect(parseRenderOptions('post')).toBeNull();
  });

  describe('ducking', () => {
    it('省略は有効（undefined のまま通す・後方互換）', () => {
      const parsed = parseRenderOptions({ resolution: 'full', quality: 'high' });
      expect(parsed).toEqual({ resolution: 'full', quality: 'high' });
      expect(parsed && 'ducking' in parsed).toBe(false);
    });
    it('supplied（enabled・strength）はそのまま返す', () => {
      expect(parseRenderOptions({ resolution: 'full', quality: 'high', ducking: { enabled: true, strength: 'mid' } }))
        .toEqual({ resolution: 'full', quality: 'high', ducking: { enabled: true, strength: 'mid' } });
      expect(parseRenderOptions({ resolution: 'full', quality: 'high', ducking: { enabled: false, strength: 'weak' } }))
        .toEqual({ resolution: 'full', quality: 'high', ducking: { enabled: false, strength: 'weak' } });
    });
    it('不正値（strength 非 enum・enabled 非 boolean）は null', () => {
      expect(parseRenderOptions({ resolution: 'full', quality: 'high', ducking: { enabled: true, strength: 'x' } }))
        .toBeNull();
      expect(parseRenderOptions({ resolution: 'full', quality: 'high', ducking: { enabled: 'yes', strength: 'mid' } }))
        .toBeNull();
      expect(parseRenderOptions({ resolution: 'full', quality: 'high', ducking: 'mid' })).toBeNull();
    });
  });
});

describe('matchPreset', () => {
  it('プリセットと一致すれば id、しなければ null（カスタム）', () => {
    expect(matchPreset(RENDER_PRESETS.post)).toBe('post');
    expect(matchPreset(RENDER_PRESETS.light)).toBe('light');
    expect(matchPreset({ resolution: '720p', quality: 'high' })).toBeNull();
  });
});

describe('presetLabel', () => {
  it('post は orientation で投稿先名が変わる', () => {
    expect(presetLabel('post', 'portrait')).toContain('ショート');
    expect(presetLabel('post', 'landscape')).toContain('YouTube');
    expect(presetLabel('post', 'square')).toContain('フィード');
  });
  it('standard / light は共通ラベル', () => {
    expect(presetLabel('standard', 'portrait')).toContain('標準');
    expect(presetLabel('light', 'landscape')).toContain('720p');
  });
});

describe('resolutionLabel', () => {
  it('full はそのまま、720p は 2/3 の偶数ピクセル', () => {
    expect(resolutionLabel(1080, 1920, 'full')).toBe('1080×1920');
    expect(resolutionLabel(1080, 1920, '720p')).toBe('720×1280');
    expect(resolutionLabel(1920, 1080, '720p')).toBe('1280×720');
    expect(resolutionLabel(1080, 1080, '720p')).toBe('720×720');
  });
  it('1080p は短辺 1080（4K 横 → 1920×1080 / 4K 縦 → 1080×1920）', () => {
    expect(resolutionLabel(3840, 2160, '1080p')).toBe('1920×1080');
    expect(resolutionLabel(2160, 3840, '1080p')).toBe('1080×1920');
    expect(resolutionLabel(2160, 2160, '1080p')).toBe('1080×1080');
  });
  it('原本が 1080 以下なら 1080p を選んでも拡大しない', () => {
    expect(resolutionLabel(1280, 720, '1080p')).toBe('1280×720');
  });
});

it('postScaleArgsの音声は320 kbpsを維持する',()=>{
  const args=postScaleArgs({resolution:'full',quality:'high'},'in.mkv','out.mp4',{width:320,height:180},'aac');
  expect(args[args.indexOf('-b:a')+1]).toBe('320k');
});
