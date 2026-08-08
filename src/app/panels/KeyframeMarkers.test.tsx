/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { KeyframeMarkers } from './KeyframeMarkers';

const kfs = [
  { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
  { originalFrame: 50, x: 0.5, y: 0, scale: 2, rotation: 0 },
];

afterEach(() => cleanup());

describe('KeyframeMarkers', () => {
  it('layoutKeyframes が 2 点未満/未指定なら何も描画しない', () => {
    const { container } = render(
      <KeyframeMarkers layoutKeyframes={[]} cutRegions={[]} fps={30} frameToX={(f) => f} />,
    );
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(
      <KeyframeMarkers layoutKeyframes={[kfs[0]!]} cutRegions={[]} fps={30} frameToX={(f) => f} />,
    );
    expect(c2.firstChild).toBeNull();
  });

  it('2点以上あれば KF1/KF2 の2マーカーを描画する', () => {
    const { container } = render(
      <KeyframeMarkers layoutKeyframes={kfs} cutRegions={[]} fps={30} frameToX={(f) => f} />,
    );
    const markers = within(container).getAllByRole('button');
    expect(markers).toHaveLength(2);
    expect(markers[0]!.title).toContain('KF1');
    expect(markers[1]!.title).toContain('KF2');
  });

  it('カット区間内の KF はスキップする（originalToPlayback が null）', () => {
    const { container } = render(
      <KeyframeMarkers
        layoutKeyframes={kfs}
        cutRegions={[{ start: 40, end: 60 }]}
        fps={30}
        frameToX={(f) => f}
      />,
    );
    const markers = within(container).getAllByRole('button');
    // originalFrame=50 はカット区間 [40,60) 内なのでスキップされ、KF1（originalFrame=0）だけ残る。
    expect(markers).toHaveLength(1);
    expect(markers[0]!.title).toContain('KF1');
  });

  it('クリックで onSeek に再生フレームを渡す', () => {
    const onSeek = vi.fn();
    const { container } = render(
      <KeyframeMarkers layoutKeyframes={kfs} cutRegions={[]} fps={30} frameToX={(f) => f} onSeek={onSeek} />,
    );
    const markers = within(container).getAllByRole('button');
    fireEvent.click(markers[1]!);
    expect(onSeek).toHaveBeenCalledWith(50);
  });
});
