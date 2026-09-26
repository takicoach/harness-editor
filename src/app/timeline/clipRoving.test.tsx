/**
 * @vitest-environment jsdom
 *
 * クリップのロービング tabindex（WAI-ARIA APG）の回帰テスト（サイクル 4 レビュー Important）。
 *
 * 旧実装は 6 トラック全部が全クリップに `tabIndex={0}` を付けており、案件
 * 2026-09-04-C0123（じまく 82＋テロップ 8＋画像 15＋効果音 14…）では 120 個超の
 * タブ停止が並んだ。キーボード利用者と AI エージェントはタイムラインへ入ると
 * 前方へ抜けるのに 100 回超の Tab が要り、監査 interaction-10 の到達コストが実用外だった。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { EditorTelop } from '../../core/types';
import { TelopTrack } from './TelopTrack';
import { rovingStopId, rovingTabIndex, nextClipIndex, clipNavIntentOf } from './clipAria';

afterEach(() => {
  cleanup();
});

const TELOPS: EditorTelop[] = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  originalStart: i * 100,
  originalEnd: i * 100 + 50,
  text: `字幕${i + 1}`,
  template: 1,
}));

function renderTrack(selectedTelopId: number | null) {
  return render(
    <TelopTrack
      fps={30}
      pxPerFrame={1}
      telops={TELOPS}
      selectedTelopId={selectedTelopId}
      liveOverride={null}
      selectedHandle={null}
      onHandleDown={() => {}}
      label="じまく"
      variant="subtitle"
    />,
  );
}

describe('rovingStopId / rovingTabIndex（純関数）', () => {
  it('選択中がそのトラックに居ればそれが唯一の停止', () => {
    expect(rovingStopId([1, 2, 3], 2)).toBe(2);
    expect(rovingTabIndex(2, [1, 2, 3], 2)).toBe(0);
    expect(rovingTabIndex(1, [1, 2, 3], 2)).toBe(-1);
  });

  it('選択が別トラック（または未選択）なら先頭が停止＝入口は必ず残る', () => {
    expect(rovingStopId([4, 5], null)).toBe(4);
    expect(rovingStopId([4, 5], 99)).toBe(4);
  });

  it('クリップ 0 件のトラックには停止が無い', () => {
    expect(rovingStopId([], 1)).toBeNull();
  });
});

describe('クリップ移動キー（純関数）', () => {
  it('↑/↓・Home/End だけを移動として扱う（←/→ は 1 フレーム微調整のまま）', () => {
    expect(clipNavIntentOf('ArrowDown')).toBe('next');
    expect(clipNavIntentOf('ArrowUp')).toBe('prev');
    expect(clipNavIntentOf('Home')).toBe('first');
    expect(clipNavIntentOf('End')).toBe('last');
    expect(clipNavIntentOf('ArrowRight'), '←/→ を奪うと 1 コマ微調整に届かなくなる').toBeNull();
    expect(clipNavIntentOf('ArrowLeft')).toBeNull();
  });

  it('両端では止まる（巻き戻らない）', () => {
    expect(nextClipIndex(3, 2, 'next')).toBe(2);
    expect(nextClipIndex(3, 0, 'prev')).toBe(0);
    expect(nextClipIndex(3, 1, 'first')).toBe(0);
    expect(nextClipIndex(3, 1, 'last')).toBe(2);
    expect(nextClipIndex(0, 0, 'next')).toBe(-1);
  });
});

describe('TelopTrack のタブ停止（実 DOM）', () => {
  it('クリップが 8 件でもタブ停止は 1 個だけ', () => {
    const { container } = renderTrack(null);
    expect(container.querySelectorAll('.tl-telop')).toHaveLength(8);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(container.querySelectorAll('[tabindex="-1"]')).toHaveLength(7);
  });

  it('停止は選択中のクリップ（選択が変われば停止も移る）', () => {
    const { container } = renderTrack(5);
    const stop = container.querySelector('[tabindex="0"]') as HTMLElement;
    expect(stop.dataset.id).toBe('5');
  });

  it('↓ で次のクリップへフォーカスが移る（停止以外へも届く）', () => {
    const { container } = renderTrack(1);
    const clips = Array.from(container.querySelectorAll<HTMLElement>('.tl-telop'));
    clips[0]!.focus();
    fireEvent.keyDown(clips[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(clips[1]);
    fireEvent.keyDown(clips[1]!, { key: 'End' });
    expect(document.activeElement).toBe(clips[7]);
    fireEvent.keyDown(clips[7]!, { key: 'Home' });
    expect(document.activeElement).toBe(clips[0]);
  });
});
