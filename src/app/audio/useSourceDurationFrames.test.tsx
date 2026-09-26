/**
 * @vitest-environment jsdom
 */
/**
 * useSourceDurationFrames のユニットテスト（R-1 レビュー差し戻し対応）。
 *
 * 差し戻しの実測: 本リポジトリの標準サブ動画フィクスチャ cam2.mp4 は video-only
 * （音声ストリーム無し）で、Web Audio の decodeAudioData は `EncodingError` で例外になる。
 * 音声デコードだけに依存した実装では、この典型ケースで常に null（=長さ不明・警告非表示）
 * になり、受け入れ基準2「超過しそうな操作をすると Inspector で警告が出る」を満たせない。
 *
 * そこで音声デコード失敗時は <video> 要素のメタデータ（duration。音声トラック非依存）へ
 * フォールバックする。ここではそのフォールバック経路を固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSourceDurationFrames } from './useSourceDurationFrames';

vi.mock('./decodeAudio', () => ({
  loadWaveformSamples: vi.fn(),
  getCachedDurationSec: vi.fn(() => null),
}));

describe('useSourceDurationFrames', () => {
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
  });

  /** document.createElement('video') を、生成直後に自分で操作できるスタブへ差し替える。 */
  function stubVideoElement(): { fireLoaded: (durationSec: number) => void; fireError: () => void } {
    let el: (HTMLVideoElement & { duration: number }) | null = null;
    document.createElement = ((tag: string) => {
      if (tag !== 'video') return originalCreateElement(tag);
      const video = originalCreateElement('video') as HTMLVideoElement & { duration: number };
      Object.defineProperty(video, 'duration', { value: NaN, writable: true, configurable: true });
      el = video;
      return video;
    }) as typeof document.createElement;
    return {
      fireLoaded: (durationSec: number) => {
        if (el === null) throw new Error('video element not created yet');
        (el as HTMLVideoElement & { duration: number }).duration = durationSec;
        el.dispatchEvent(new Event('loadedmetadata'));
      },
      fireError: () => {
        if (el === null) throw new Error('video element not created yet');
        el.dispatchEvent(new Event('error'));
      },
    };
  }

  it('音声デコードが失敗しても <video> メタデータの duration からフレーム数を出す（video-only ソース）', async () => {
    const { loadWaveformSamples } = await import('./decodeAudio');
    vi.mocked(loadWaveformSamples).mockRejectedValue(new Error('EncodingError: Unable to decode audio data'));
    const video = stubVideoElement();

    const { result } = renderHook(() => useSourceDurationFrames('/api/video?file=cam2.mp4', 30));

    await vi.waitFor(() => video.fireLoaded(10)); // 10秒 * 30fps = 300フレーム（video要素生成後に発火）

    await waitFor(() => expect(result.current).toBe(300));
  });

  it('音声デコードもビデオメタデータも失敗すれば null（長さ不明・警告なし＝安全側）', async () => {
    const { loadWaveformSamples } = await import('./decodeAudio');
    vi.mocked(loadWaveformSamples).mockRejectedValue(new Error('no audio track'));
    const video = stubVideoElement();

    const { result } = renderHook(() => useSourceDurationFrames('/api/video?file=silent-video-only.mp4', 30));
    await vi.waitFor(() => video.fireError());

    await waitFor(() => expect(result.current).toBeNull());
  });

  it('音声デコードが成功すればそれを使う（video メタデータへは回らない）', async () => {
    const { loadWaveformSamples, getCachedDurationSec } = await import('./decodeAudio');
    vi.mocked(loadWaveformSamples).mockResolvedValue(new Float32Array());
    vi.mocked(getCachedDurationSec).mockReturnValue(5); // 5秒
    document.createElement = ((tag: string) => {
      if (tag === 'video') throw new Error('video フォールバックは呼ばれてはいけない');
      return originalCreateElement(tag);
    }) as typeof document.createElement;

    const { result } = renderHook(() => useSourceDurationFrames('/api/video?file=with-audio.mp4', 30));

    await waitFor(() => expect(result.current).toBe(150)); // 5秒 * 30fps
  });

  it('url が null なら何もしない（null）', () => {
    const { result } = renderHook(() => useSourceDurationFrames(null, 30));
    expect(result.current).toBeNull();
  });
});
