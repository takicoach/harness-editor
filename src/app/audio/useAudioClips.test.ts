/**
 * @vitest-environment jsdom
 */
/**
 * useAudioClips のユニットテスト（G-3・B-5差し戻し対応）。
 *
 * 差し戻しの実測: 従来は decodeAudio のデコード失敗を `.catch(() => {})` で握り潰し、
 * 呼び出し側（MaterialLibrary 等）は「まだロード中」か「実際に失敗した」かを区別できず、
 * 波形が永久に出ない理由をユーザーに見せられなかった。ここでは失敗が `failed: true` として
 * 状態に反映されることを固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAudioClips } from './useAudioClips';

vi.mock('./decodeAudio', () => ({
  loadAudioClip: vi.fn((url: string) => {
    if (url === 'ok.mp3') return Promise.resolve({ samples: new Float32Array([0.1, 0.2]), durationSec: 1 });
    return Promise.reject(new Error('moov atom not found'));
  }),
}));

describe('useAudioClips', () => {
  it('デコード成功時は clip を返し failed=false', async () => {
    const { result } = renderHook(() => useAudioClips(['ok.mp3']));
    await waitFor(() => expect(result.current[0]?.clip).not.toBeNull());
    expect(result.current[0]?.failed).toBe(false);
  });

  it('デコード失敗時は clip=null のまま failed=true になる（無言で消えない）', async () => {
    const { result } = renderHook(() => useAudioClips(['broken.mp3']));
    await waitFor(() => expect(result.current[0]?.failed).toBe(true));
    expect(result.current[0]?.clip).toBeNull();
  });

  it('url=null は failed=false のまま（未指定と失敗を区別する）', () => {
    const { result } = renderHook(() => useAudioClips([null]));
    expect(result.current[0]).toEqual({ clip: null, failed: false });
  });
});
