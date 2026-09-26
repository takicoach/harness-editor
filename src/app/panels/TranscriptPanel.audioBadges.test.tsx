/**
 * @vitest-environment jsdom
 */
/**
 * status-ia-7: 「音声」セクションを閉じたままでも、ノイズ除去・音量調整の
 * 実行中／失敗が summary のバッジで分かること。
 * 状態フックはスタブに差し替え、バッジの描画だけを見る。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { initialEditState } from '../edit/editState';
import type { Transcript } from '../../core/types';
import type { DenoiseState } from '../useDenoise';
import type { NormalizeState } from '../useNormalize';

const heavyJobConfirm = { pendingConfirm: null, confirm: () => {}, dismiss: () => {}, start: async () => 'cancelled' };

let denoiseState: DenoiseState = { status: 'idle', applied: false };
let normalizeState: NormalizeState = { status: 'idle', applied: false };

vi.mock('../useDenoise', () => ({
  useDenoise: () => ({
    state: denoiseState,
    start: async () => {},
    restore: async () => {},
    dismissError: () => {},
    heavyJobConfirm,
  }),
}));
vi.mock('../useNormalize', () => ({
  useNormalize: () => ({
    state: normalizeState,
    start: async () => {},
    restore: async () => {},
    dismissError: () => {},
    heavyJobConfirm,
  }),
}));
vi.mock('../usePreviewProxy', () => ({
  usePreviewProxy: () => ({
    state: { status: 'idle' },
    dismissed: true,
    dismiss: () => {},
    start: async () => {},
    heavyJobConfirm,
  }),
}));

const transcript: Transcript = { durationMs: 0, words: [], segments: [] };
const noop = () => {};

afterEach(() => {
  cleanup();
  denoiseState = { status: 'idle', applied: false };
  normalizeState = { status: 'idle', applied: false };
});

async function renderPanel() {
  const { TranscriptPanel } = await import('./TranscriptPanel');
  return render(
    <TranscriptPanel
      state={{ ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }), telops: [], selection: null }}
      transcript={transcript}
      fps={30}
      transcriptAligned
      cutsBypassed={false}
      projectId="p1"
      onReloadRequested={noop}
      onEdit={noop}
      onSelect={noop}
      onSeek={noop}
      highlightRange={null}
      onHighlightRange={noop}
      playerRef={{ current: null } as never}
      model={null}
    />,
  );
}

describe('TranscriptPanel — 音声セクションの状態バッジ（status-ia-7）', () => {
  it('実行中はバッジが出る（セクションを開かなくても分かる）', async () => {
    denoiseState = { status: 'running', phase: 'denoising', startedAt: 0, applied: false };
    normalizeState = { status: 'running', phase: 'measuring', startedAt: 0, applied: false };
    const { queryByTestId } = await renderPanel();
    expect(queryByTestId('audio-badge-denoise-running')).not.toBeNull();
    expect(queryByTestId('audio-badge-normalize-running')).not.toBeNull();
  });

  it('失敗もバッジで出る', async () => {
    denoiseState = { status: 'error', error: { code: 'boom', message: 'x' }, applied: false };
    normalizeState = { status: 'error', error: { code: 'boom', message: 'x' }, applied: false };
    const { queryByTestId } = await renderPanel();
    expect(queryByTestId('audio-badge-denoise-error')).not.toBeNull();
    expect(queryByTestId('audio-badge-normalize-error')).not.toBeNull();
  });

  it('idle のときはどちらのバッジも出ない', async () => {
    const { queryByTestId } = await renderPanel();
    expect(queryByTestId('audio-badge-denoise-running')).toBeNull();
    expect(queryByTestId('audio-badge-denoise-error')).toBeNull();
    expect(queryByTestId('audio-badge-normalize-running')).toBeNull();
    expect(queryByTestId('audio-badge-normalize-error')).toBeNull();
  });
});
