/**
 * @vitest-environment jsdom
 *
 * ドラッグツールチップの縦位置（監査 interaction-9）。
 *
 * 以前は `left` しか指定しておらず、DragTooltip 群が全トラックの後ろに絶対配置される
 * ため、どのトラックを掴んでもツールチップは最下段付近に出ていた。
 * コメントの「つまみ位置の上へ出す」と実際が食い違っていた。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DragTooltip } from './DragTooltip';
import { frameToX } from './timelineGeometry';

afterEach(cleanup);

function tooltip(top?: number): HTMLElement {
  const { container } = render(
    <DragTooltip frame={300} originFrame={200} pxPerFrame={2} fps={30} top={top} />,
  );
  return container.querySelector('.tl-tooltip') as HTMLElement;
}

describe('DragTooltip', () => {
  it('掴んだトラックの上端が渡されればそこへ出す', () => {
    expect(tooltip(94).style.top).toBe('94px');
  });

  it('先頭トラック（top=0）でも 0 を反映する（未指定と区別する）', () => {
    expect(tooltip(0).style.top).toBe('0px');
  });

  it('未指定なら top を書かない（従来どおり最下段）', () => {
    expect(tooltip(undefined).style.top).toBe('');
  });

  it('横位置は従来どおりフレーム由来（縦位置の追加で壊さない）', () => {
    expect(tooltip(94).style.left).toBe(`${frameToX(300, 2)}px`);
  });

  it('絶対時刻と移動量を出す', () => {
    const el = tooltip(94);
    expect(el.textContent).toContain('0:10'); // 300/30 秒
    expect(el.textContent).toContain('+100f');
  });
});
