/**
 * @vitest-environment jsdom
 *
 * 極小クリップの端つまみ（監査 interaction-4）の DOM 回帰テスト。
 *
 * 以前は幅 4px のクリップの上に 10px のつまみが 2 つ載り、本体（＝掴んで動かす面）の
 * 露出がゼロになっていた。ズームアウトしてテロップを掴もうとすると必ずどちらかの端を
 * 掴むことになり、DOM 順で後ろの end が勝つため「左を押したのに右端が伸びる」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TelopTrack } from './TelopTrack';
import type { EditorTelop } from '../../core/types';

afterEach(cleanup);

const TELOPS: EditorTelop[] = [
  { id: 1, originalStart: 0, originalEnd: 60, text: '短い字幕', template: 1 },
];

function renderAt(pxPerFrame: number): HTMLElement {
  const { container } = render(
    <TelopTrack
      pxPerFrame={pxPerFrame}
      telops={TELOPS}
      label="じまく"
      variant="subtitle"
      fps={30}
      selectedTelopId={null}
      liveOverride={null}
      selectedHandle={null}
      onHandleDown={vi.fn()}
    />,
  );
  return container;
}

function handles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tl-handle'));
}

describe('TelopTrack のつまみ幅（interaction-4）', () => {
  it('ズームアウト（幅 4px 相当）ではつまみを描かない＝本体を掴める', () => {
    // 60 フレーム × 0.05px = 3px → width の下限 4px が効いて 4px。
    const c = renderAt(0.05);
    const clip = c.querySelector<HTMLElement>('.tl-telop');
    expect(clip?.style.width).toBe('4px');
    const hs = handles(c);
    expect(hs).toHaveLength(2);
    for (const h of hs) expect(h.style.display).toBe('none');
  });

  it('しきい値ちょうど（24px）ではつまみを 1/3 まで縮めて描く', () => {
    // 60 フレーム × 0.4px = 24px。
    const c = renderAt(0.4);
    expect(c.querySelector<HTMLElement>('.tl-telop')?.style.width).toBe('24px');
    const [start, end] = handles(c);
    expect(start?.style.display).not.toBe('none');
    expect(start?.style.width).toBe('8px');
    expect(start?.style.left).toBe('-4px');
    expect(end?.style.width).toBe('8px');
    expect(end?.style.right).toBe('-4px');
  });

  it('十分広ければ従来どおり 10px・±5px（見た目を変えない）', () => {
    const c = renderAt(4);
    const [start, end] = handles(c);
    expect(start?.style.width).toBe('10px');
    expect(start?.style.left).toBe('-5px');
    expect(end?.style.width).toBe('10px');
    expect(end?.style.right).toBe('-5px');
  });
});
