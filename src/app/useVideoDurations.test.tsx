/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import {
  durationToFrames,
  pendingProbeUrls,
  useVideoDurations,
  type VideoDurationProbe,
} from './useVideoDurations';

afterEach(() => {
  cleanup();
});

describe('durationToFrames', () => {
  it('秒 × fps を切り捨てる（素材の外へはみ出させない）', () => {
    expect(durationToFrames(10, 60)).toBe(600);
    expect(durationToFrames(1.999, 60)).toBe(119);
  });

  it('非有限・非正・fps 不正は null（実尺不明）', () => {
    expect(durationToFrames(Number.NaN, 60)).toBeNull();
    expect(durationToFrames(Infinity, 60)).toBeNull();
    expect(durationToFrames(0, 60)).toBeNull();
    expect(durationToFrames(-1, 60)).toBeNull();
    expect(durationToFrames(10, 0)).toBeNull();
  });

  it('1 フレームに満たない極短素材は null（0 フレームを実尺として配らない）', () => {
    expect(durationToFrames(0.001, 60)).toBeNull();
  });
});

describe('pendingProbeUrls', () => {
  it('既知・空文字・重複を除く', () => {
    expect(pendingProbeUrls(['a', 'b', 'a', '', 'c'], { b: 100 })).toEqual(['a', 'c']);
  });
});

describe('useVideoDurations', () => {
  it('ライブラリ各ファイルをプローブし file → frames を返す', async () => {
    const probe: VideoDurationProbe = async (url) => (url.includes('cam2') ? 10 : 4);
    const { result } = renderHook(() =>
      useVideoDurations('p1', ['sub/cam2.mp4', 'sub/cam3.mp4'], 60, undefined, probe),
    );
    await waitFor(() => {
      expect(result.current).toEqual({ 'sub/cam2.mp4': 600, 'sub/cam3.mp4': 240 });
    });
  });

  it('読めなかった素材はマップに載せない（実尺不明＝クランプしない）', async () => {
    const probe: VideoDurationProbe = async (url) => (url.includes('broken') ? null : 2);
    const { result } = renderHook(() =>
      useVideoDurations('p1', ['ok.mp4', 'broken.mp4'], 60, undefined, probe),
    );
    await waitFor(() => {
      expect(result.current['ok.mp4']).toBe(120);
    });
    expect(result.current).not.toHaveProperty('broken.mp4');
  });

  it('プローブは 1 本ずつ直列に走る（同時接続でライブラリを詰まらせない）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe: VideoDurationProbe = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return 1;
    };
    const { result } = renderHook(() =>
      useVideoDurations('p1', ['a.mp4', 'b.mp4', 'c.mp4'], 30, undefined, probe),
    );
    await waitFor(() => {
      expect(Object.keys(result.current)).toHaveLength(3);
    });
    expect(maxInFlight).toBe(1);
  });

  it('再レンダーしても同じ URL を再プローブしない', async () => {
    const probe = vi.fn<VideoDurationProbe>(async () => 3);
    const library = ['a.mp4'];
    const { result, rerender } = renderHook(() =>
      useVideoDurations('p1', library, 60, undefined, probe),
    );
    await waitFor(() => {
      expect(result.current['a.mp4']).toBe(180);
    });
    rerender();
    rerender();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('同名差し替え（assetVersions 変化）で URL が変わると再プローブする', async () => {
    const probe = vi.fn<VideoDurationProbe>(async (url) => (url.includes('v=2') ? 5 : 3));
    const { result, rerender } = renderHook(
      ({ versions }: { versions: Record<string, string> }) =>
        useVideoDurations('p1', ['a.mp4'], 60, versions, probe),
      { initialProps: { versions: { 'a.mp4': '1' } } },
    );
    await waitFor(() => {
      expect(result.current['a.mp4']).toBe(180);
    });
    rerender({ versions: { 'a.mp4': '2' } });
    await waitFor(() => {
      expect(result.current['a.mp4']).toBe(300);
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('projectId が空なら何もしない（プロジェクト未選択）', async () => {
    const probe = vi.fn<VideoDurationProbe>(async () => 3);
    const { result } = renderHook(() => useVideoDurations('', ['a.mp4'], 60, undefined, probe));
    await new Promise((r) => setTimeout(r, 5));
    expect(probe).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});
