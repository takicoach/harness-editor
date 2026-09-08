/**
 * @vitest-environment jsdom
 *
 * useTimelineDrag の「クリック vs ドラッグ」判定。
 *
 * ここは実 pointermove を window へ発火させて検証する。純関数テストでは
 * movedRef を恒偽（＝常に onClick）にする変異が全緑のまま生き残るため
 * （ユニット層に pointermove を発火するテストが 1 件も無かった）。
 *
 * 判定は **生の画面 X（px）** で行う契約。吸着後のフレーム値で比較すると、
 * 掴んだ端が吸着点の近くにあるとき「動かしたのに動いていない」と誤判定して
 * コミットが落ち、ライブ表示から巻き戻る。下の 3 件目がその退行を固定する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useTimelineDrag } from './useTimelineDrag';
import { CLICK_MOVE_THRESHOLD_PX, TRACK_LABEL_GUTTER_PX } from './timelineGeometry';

type Handle = 'h';

interface HarnessProps {
  onCommit: (handle: Handle, finalFrame: number) => void;
  onClick?: (handle: Handle) => void;
  /** 吸着相当の変換。既定は恒等。 */
  snap?: (rawFrame: number) => number;
  /** 端ドラッグ自動スクロールが足した累積 px（省略時は未配線＝従来式）。 */
  getAutoScrollDx?: () => number;
  /** トラック原点。ズーム・パネル開閉で動く状況を再現する（既定は 0 固定）。 */
  getTrackOriginX?: () => number;
  /** ドラッグ取り消し（pointercancel / Escape）。 */
  onCancel?: (handle: Handle) => void;
}

const PX_PER_FRAME = 2;
const ORIGIN_FRAME = 100;
/** つまみを掴む画面 X（トラック原点は 0・ガター分だけ右にある）。 */
const GRAB_X = TRACK_LABEL_GUTTER_PX + ORIGIN_FRAME * PX_PER_FRAME;

function Harness({ onCommit, onClick, snap, getAutoScrollDx, getTrackOriginX, onCancel }: HarnessProps) {
  const { drag, beginDrag } = useTimelineDrag<Handle>({
    getTrackOriginX: getTrackOriginX ?? (() => 0),
    pxPerFrame: PX_PER_FRAME,
    onDrag: (_h, rawFrame) => (snap ? snap(rawFrame) : rawFrame),
    onCommit,
    ...(onClick ? { onClick } : {}),
    ...(getAutoScrollDx ? { getAutoScrollDx } : {}),
    ...(onCancel ? { onCancel } : {}),
  });
  return (
    <div
      data-testid="handle"
      data-frame={drag === null ? 'none' : String(drag.frame)}
      data-moved={drag === null ? 'none' : String(drag.moved)}
      onPointerDown={(e) => beginDrag('h', e, ORIGIN_FRAME)}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe('useTimelineDrag: クリックとドラッグの判定', () => {
  it('しきい値を超える pointermove があれば onCommit が呼ばれる', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(<Harness onCommit={onCommit} onClick={onClick} />);

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    // +40px = +20 フレーム。
    fireEvent.pointerMove(window, { clientX: GRAB_X + 40 });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 40 });

    expect(onClick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('h', ORIGIN_FRAME + 20);
  });

  it('pointermove が無い／しきい値以内なら onClick が呼ばれ onCommit は呼ばれない', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(<Harness onCommit={onCommit} onClick={onClick} />);

    // (a) pointermove が 1 度も無い純クリック。
    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    fireEvent.pointerUp(window, { clientX: GRAB_X });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);

    // (b) しきい値以内の微振動。
    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    fireEvent.pointerMove(window, { clientX: GRAB_X + CLICK_MOVE_THRESHOLD_PX });
    fireEvent.pointerUp(window, { clientX: GRAB_X + CLICK_MOVE_THRESHOLD_PX });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('吸着で出力フレームが変わらない小ドラッグでもコミットされる（px 判定の回帰）', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    // 掴んだ端が吸着点上にあり、多少動かしても吸着後の値が動かない状況。
    const { getByTestId } = render(
      <Harness onCommit={onCommit} onClick={onClick} snap={() => ORIGIN_FRAME} />,
    );

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    fireEvent.pointerMove(window, { clientX: GRAB_X + 40 });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 40 });

    // 吸着後のフレーム値で判定していると movedRef=false になり onClick へ落ちる。
    expect(onClick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('h', ORIGIN_FRAME);
  });

  it('onClick 未指定なら純クリックでも従来どおり onCommit が呼ばれる（範囲選択系の互換）', () => {
    const onCommit = vi.fn();
    const { getByTestId } = render(<Harness onCommit={onCommit} />);

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    fireEvent.pointerUp(window, { clientX: GRAB_X });

    expect(onCommit).toHaveBeenCalledWith('h', ORIGIN_FRAME);
  });
});

/**
 * クリック/ドラッグ判定に足してよいのは「**自前の**端ドラッグ自動スクロール量」だけ、
 * という契約の固定。トラック原点の移動量で測ると、ズーム・サブパネル開閉・再生追従の
 * ような**ユーザーが動かしていない**原点移動までドラッグ扱いになる。
 */
describe('useTimelineDrag: 移動量に数えるもの／数えないもの', () => {
  it('自動スクロールが足した量は移動量に数える（ポインタが止まっていても確定する）', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    let autoDx = 0;
    const { getByTestId } = render(
      <Harness onCommit={onCommit} onClick={onClick} getAutoScrollDx={() => autoDx} />,
    );

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    // 実移動はしきい値以下。この時点ではまだクリック候補。
    fireEvent.pointerMove(window, { clientX: GRAB_X + 2 });
    // 端スクロールが 20px ぶんコンテンツを送った。ポインタは止まったまま。
    autoDx = 20;
    fireEvent.pointerMove(window, { clientX: GRAB_X + 2 });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 2 });

    expect(onClick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('自動スクロール以外の原点移動（ズーム・パネル開閉）は数えない', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    // 掴んだ後にトラック原点が 100px 左へ動く（＝コンテンツが 100px 進んで見える）。
    let originX = 0;
    const { getByTestId } = render(
      <Harness
        onCommit={onCommit}
        onClick={onClick}
        getTrackOriginX={() => originX}
        getAutoScrollDx={() => 0}
      />,
    );

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    originX = -100;
    fireEvent.pointerMove(window, { clientX: GRAB_X + 2 });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 2 });

    // 原点差で測っていると 102px 動いた扱いになりクリックがドラッグへ化ける。
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('getAutoScrollDx 未配線なら従来どおり画面 X の差だけで判定する', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(<Harness onCommit={onCommit} onClick={onClick} />);

    fireEvent.pointerDown(getByTestId('handle'), { clientX: GRAB_X });
    fireEvent.pointerMove(window, { clientX: GRAB_X + 40 });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 40 });

    expect(onCommit).toHaveBeenCalledWith('h', ORIGIN_FRAME + 20);
  });

  it('drag.moved は純クリックの間 false、しきい値を超えたら true になる', () => {
    const onCommit = vi.fn();
    const { getByTestId } = render(<Harness onCommit={onCommit} onClick={() => {}} />);
    const el = getByTestId('handle');

    fireEvent.pointerDown(el, { clientX: GRAB_X });
    expect(el.dataset.moved).toBe('false');
    fireEvent.pointerMove(window, { clientX: GRAB_X + 2 });
    expect(el.dataset.moved).toBe('false');
    fireEvent.pointerMove(window, { clientX: GRAB_X + 40 });
    expect(el.dataset.moved).toBe('true');
    fireEvent.pointerUp(window, { clientX: GRAB_X + 40 });
  });
});

describe('useTimelineDrag: 取り消し（監査 interaction-3）', () => {
  function beginAndMove(): {
    commits: [Handle, number][];
    cancels: Handle[];
    el: HTMLElement;
  } {
    const commits: [Handle, number][] = [];
    const cancels: Handle[] = [];
    const { getByTestId } = render(
      <Harness
        onCommit={(h, f) => commits.push([h, f])}
        onCancel={(h) => cancels.push(h)}
      />,
    );
    const el = getByTestId('handle');
    fireEvent.pointerDown(el, { clientX: GRAB_X, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: GRAB_X + 60, clientY: 0 });
    return { commits, cancels, el };
  }

  it('pointercancel は確定しない（その時点の位置で置き去りにしない）', () => {
    const { commits, cancels, el } = beginAndMove();
    fireEvent.pointerCancel(window, { clientX: GRAB_X + 60, clientY: 0 });
    expect(commits).toHaveLength(0);
    expect(cancels).toEqual(['h']);
    expect(el.dataset['frame']).toBe('none');
  });

  it('ドラッグ中の Escape で取り消せる（掴んだ後にやめられる）', () => {
    const { commits, cancels, el } = beginAndMove();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(commits).toHaveLength(0);
    expect(cancels).toEqual(['h']);
    expect(el.dataset['frame']).toBe('none');
  });

  it('Escape 以外のキーでは取り消さない', () => {
    const { commits, cancels } = beginAndMove();
    fireEvent.keyDown(window, { key: 'a' });
    expect(cancels).toHaveLength(0);
    fireEvent.pointerUp(window, { clientX: GRAB_X + 60, clientY: 0 });
    expect(commits).toHaveLength(1);
  });

  it('取り消した後の pointerup では確定しない（二重終了で復活しない）', () => {
    const { commits } = beginAndMove();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientX: GRAB_X + 60, clientY: 0 });
    expect(commits).toHaveLength(0);
  });

  it('pointerup は従来どおり確定する（取り消し経路が確定を壊さない）', () => {
    const { commits, cancels } = beginAndMove();
    fireEvent.pointerUp(window, { clientX: GRAB_X + 60, clientY: 0 });
    expect(commits).toHaveLength(1);
    expect(cancels).toHaveLength(0);
  });

  it('ドラッグしていないときの Escape は無視される（購読が漏れていない）', () => {
    const cancels: Handle[] = [];
    render(<Harness onCommit={() => {}} onCancel={(h) => cancels.push(h)} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancels).toHaveLength(0);
  });
});
