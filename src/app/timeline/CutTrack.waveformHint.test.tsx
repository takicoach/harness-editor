/**
 * @vitest-environment jsdom
 *
 * X-2(b) 回帰固定: 動画トラックの「波形なし（音声を読み込めません）」ヒントは
 * **デコードが実際に失敗したときだけ**出る。
 *
 * 実測した不具合: 従来は samples === null だけで判定していたため、デコード成功前の
 * 読み込み中にも同じ文言が一瞬（重い動画なら数秒）表示された。利用者からは
 * 「音声が読めない故障」に見える。読み込み中と失敗は別物として分離する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { CutTrack } from './CutTrack';

const slow: { resolve: ((s: Float32Array) => void) | null } = { resolve: null };

vi.mock('../audio/decodeAudio', () => ({
  loadWaveformSamples: vi.fn((url: string) => {
    if (url.includes('broken')) return Promise.reject(new Error('moov atom not found'));
    return new Promise<Float32Array>((res) => { slow.resolve = res; });
  }),
}));

afterEach(() => {
  cleanup();
  slow.resolve = null;
  vi.restoreAllMocks();
});

function renderTrack(videoUrl: string) {
  return render(
    <CutTrack
      totalFrames={300}
      pxPerFrame={0.5}
      cutRegions={[]}
      liveRegions={null}
      selectedHandle={null}
      onHandleDown={() => {}}
      pulseKeys={new Set<string>()}
      videoUrl={videoUrl}
    />,
  );
}

const HINT = /波形なし/;

describe('CutTrack の波形ヒント', () => {
  it('デコード中はヒントを出さない（読み込み中を失敗として見せない）', async () => {
    renderTrack('/api/video?id=p&file=main.mp4');
    expect(screen.queryByText(HINT)).toBeNull();
    // 解決してもヒントは出ない。
    slow.resolve?.(new Float32Array([0.5]));
    await waitFor(() => expect(document.querySelector('canvas.tl-waveform')).not.toBeNull());
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('デコード失敗後にだけヒントを出す', async () => {
    renderTrack('/api/video?id=p&file=broken.mp4');
    await waitFor(() => expect(screen.queryByText(HINT)).not.toBeNull());
  });

  it('videoUrl が空ならヒントを出さない（素材未指定は失敗ではない）', () => {
    renderTrack('');
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
