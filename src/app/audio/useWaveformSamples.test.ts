/**
 * @vitest-environment jsdom
 */
/**
 * useWaveformSamples のユニットテスト（X-2(b)）。
 *
 * 実測した不具合: 従来のフックは Float32Array | null しか返さず、デコード失敗を
 * console.warn へ落として握り潰していた。呼び出し側（CutTrack 等）は samples === null
 * だけで「波形なし（音声を読み込めません）」を出していたため、**デコード成功前の
 * 読み込み中にも同じ文言が出た**（重い動画ほど長く出る）。利用者には故障に見える。
 *
 * ここでは useAudioClips と同じく { samples, failed } を返し、
 * 「読み込み中（failed=false）」と「失敗（failed=true）」が区別されることを固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWaveformSamples } from './useWaveformSamples';

const slow: { resolve: ((s: Float32Array) => void) | null } = { resolve: null };

vi.mock('./decodeAudio', () => ({
  loadWaveformSamples: vi.fn((url: string) => {
    if (url === 'broken.mp4') return Promise.reject(new Error('moov atom not found'));
    if (url === 'slow.mp4') return new Promise<Float32Array>((res) => { slow.resolve = res; });
    return Promise.resolve(new Float32Array([0.1, 0.2]));
  }),
}));

describe('useWaveformSamples', () => {
  it('読み込み中は failed=false（失敗の文言を出させない）', async () => {
    const { result } = renderHook(() => useWaveformSamples('slow.mp4'));
    expect(result.current.samples).toBeNull();
    expect(result.current.failed).toBe(false);
    // 解決後は samples が入り、failed は false のまま。
    slow.resolve?.(new Float32Array([0.3]));
    await waitFor(() => expect(result.current.samples).not.toBeNull());
    expect(result.current.failed).toBe(false);
  });

  it('デコード失敗時のみ failed=true になる', async () => {
    const { result } = renderHook(() => useWaveformSamples('broken.mp4'));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.samples).toBeNull();
  });

  it('url=null は failed=false（未指定と失敗を区別する）', () => {
    const { result } = renderHook(() => useWaveformSamples(null));
    expect(result.current).toEqual({ samples: null, failed: false });
  });

  it('url が失敗から成功へ変わったら failed は解除される', async () => {
    const { result, rerender } = renderHook(({ u }: { u: string }) => useWaveformSamples(u), {
      initialProps: { u: 'broken.mp4' },
    });
    await waitFor(() => expect(result.current.failed).toBe(true));
    rerender({ u: 'ok.mp4' });
    await waitFor(() => expect(result.current.samples).not.toBeNull());
    expect(result.current.failed).toBe(false);
  });
});
