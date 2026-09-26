/**
 * @vitest-environment jsdom
 *
 * F-1: キーフレームを「打つ・動かす・消す」が UI から行えることの回帰テスト。
 * 非エンジニアが触る面なので、操作は「ボタン1つ」「スライダー1本」で完結すること自体を固定する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MotionSettings } from './MotionSettings';
import type { Motion } from '../../../core/motion';

afterEach(cleanup);

const BASE = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };

function setup(motion: Motion | undefined) {
  const onChange = vi.fn();
  render(
    <MotionSettings idPrefix="t" motion={motion} base={BASE} onChange={onChange} withOpacity />,
  );
  return onChange;
}

describe('キーフレーム UI', () => {
  it('プリセットで「キーフレーム」を選ぶと開始/終了の 2 点ができる（切替時に絵が変わらない）', () => {
    const onChange = setup(undefined);
    fireEvent.change(screen.getByLabelText('アニメの種類'), { target: { value: 'keyframes' } });
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.preset).toBe('keyframes');
    expect(next.keys).toHaveLength(2);
    expect(next.keys?.[0]?.t).toBe(0);
    expect(next.keys?.[1]?.t).toBe(1);
  });

  it('「キーフレームを打つ」で 1 点増える', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] };
    const onChange = setup(motion);
    fireEvent.click(screen.getByRole('button', { name: 'キーフレームを打つ' }));
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.keys).toHaveLength(3);
    expect(next.keys?.[1]?.t).toBeCloseTo(0.5, 10);
  });

  it('打った直後の見た目は変わらない（その時点の補間値が入る）', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] };
    const onChange = setup(motion);
    fireEvent.click(screen.getByRole('button', { name: 'キーフレームを打つ' }));
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.keys?.[1]?.scale).toBeCloseTo(1.5, 10);
  });

  it('時間スライダーでキーを動かせる', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, x: 0 }, { t: 0.5, x: 1 }, { t: 1, x: 0 }] };
    const onChange = setup(motion);
    fireEvent.change(screen.getByLabelText('2 番目のキーフレームの時間'), { target: { value: '0.9' } });
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.keys?.map((k) => k.t)).toEqual([0, 0.9, 1]);
  });

  it('キーごとの削除ボタンで消せる', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, x: 0 }, { t: 0.5, x: 1 }, { t: 1, x: 0 }] };
    const onChange = setup(motion);
    fireEvent.click(screen.getByRole('button', { name: '2 番目のキーフレームを削除' }));
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.keys?.map((k) => k.t)).toEqual([0, 1]);
  });

  it('最後の 1 点を消すとアニメ自体が外れる（undefined）', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0.4, x: 0.2 }] };
    const onChange = setup(motion);
    fireEvent.click(screen.getByRole('button', { name: '1 番目のキーフレームを削除' }));
    expect(onChange.mock.calls[0]![0]).toBeUndefined();
  });

  it('キーの値スライダーで軸を変えられる', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] };
    const onChange = setup(motion);
    fireEvent.change(screen.getByLabelText('1 番目のキーフレームの大きさ'), { target: { value: '1.6' } });
    const next = onChange.mock.calls[0]![0] as Motion;
    expect(next.keys?.[0]?.scale).toBe(1.6);
  });

  it('他のキーを追い越しても、同じスライダーは同じキーを掴み続ける', () => {
    // 時間スライダーは「表示の並び」で名前が付くが、掴む対象は保持順（＝データ側の位置）で決まる。
    // 追い越しで対象が入れ替わると、ドラッグの途中から**別のキーが動き出す**。
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, x: -1 }, { t: 0.5, x: 0 }, { t: 1, x: 1 }] };
    const onChange = vi.fn();
    const { rerender } = render(
      <MotionSettings idPrefix="t" motion={motion} base={BASE} onChange={onChange} withOpacity />,
    );
    // 3 番目（x:1）を 0.2 へ = 2 番目（t:0.5）を追い越す。
    const slider = screen.getByLabelText('3 番目のキーフレームの時間');
    fireEvent.change(slider, { target: { value: '0.2' } });
    const moved = onChange.mock.calls[0]![0] as Motion;
    expect(moved.keys?.find((k) => k.x === 1)?.t).toBeCloseTo(0.2, 10);

    // 同じ DOM スライダーで続きを動かす（＝ドラッグの継続）。
    rerender(<MotionSettings idPrefix="t" motion={moved} base={BASE} onChange={onChange} withOpacity />);
    fireEvent.change(slider, { target: { value: '0.1' } });
    const again = onChange.mock.calls[1]![0] as Motion;
    // 動いたのは依然として x:1 のキー。他は元のまま。
    expect(again.keys?.find((k) => k.x === 1)?.t).toBeCloseTo(0.1, 10);
    expect(again.keys?.find((k) => k.x === 0)?.t).toBeCloseTo(0.5, 10);
    expect(again.keys?.find((k) => k.x === -1)?.t).toBeCloseTo(0, 10);
  });

  it('表示は時間順に並ぶ（保持順が時間順でなくても見た目は昇順）', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, x: -1 }, { t: 0.5, x: 0 }, { t: 0.2, x: 1 }] };
    setup(motion);
    const titles = Array.from(document.querySelectorAll('.ins-motion-key-title')).map((e) => e.textContent ?? '');
    expect(titles.map((t) => t.match(/(\d+)%/)?.[1])).toEqual(['0', '20', '50']);
  });

  it('キーフレーム以外のプリセットではキーフレーム編集面を出さない', () => {
    setup({ preset: 'zoomIn', intensity: 0.5 });
    expect(screen.queryByRole('button', { name: 'キーフレームを打つ' })).toBeNull();
  });

  it('書き出し部品が未対応なら、その旨を利用者に伝える（黙って絵を変えない）', () => {
    const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] };
    const onChange = vi.fn();
    render(
      <MotionSettings
        idPrefix="t"
        motion={motion}
        base={BASE}
        onChange={onChange}
        keyframeSupport={{ supported: false, message: 'この案件のテロップ部品は旧版のため、キーフレームは書き出しに反映されません。' }}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain('書き出しに反映されません');
  });
});

describe('キーフレームを出さない面（メイン動画の区間 motion）', () => {
  it('withKeyframes=false ならプリセット一覧に「キーフレーム」が出ない', () => {
    render(
      <MotionSettings idPrefix="seg" motion={undefined} base={BASE} withKeyframes={false} withOpacity={false} onChange={vi.fn()} />,
    );
    const options = Array.from(screen.getByLabelText('アニメの種類').querySelectorAll('option')).map((o) => o.value);
    expect(options).not.toContain('keyframes');
  });
});
