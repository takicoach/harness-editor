/**
 * @vitest-environment jsdom
 *
 * プレビュー上のドラッグが「テロップ複数選択」中は選択全員へ同値適用されることの回帰テスト。
 * 複数選択の「揃える」意味論をプレビューのドラッグにも適用する（実機不具合: 複数選択中でも
 * プライマリしか動かなかった）。
 *
 * ここは **実 React の pointerdown → pointermove → pointerup を通した結線** だけを見る。
 * 座標変換そのもの（pointerToPosition / pointerToScale）は overlayGeometry.test.ts、
 * ops のクランプ契約は telopSettingsOps.test.ts が担う。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import type { EditorTelop } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { PreviewOverlay } from './PreviewOverlay';
import { fitContentRect, telopBoxRect } from './overlayGeometry';
import { telopScaleOriginY, telopVCoeff } from '../../preview/telopLayout';

const COMP_W = 1080;
const COMP_H = 1920;
// contain フィットがちょうど 1/4 になる stage サイズ（content = 270×480・レターボックス無し）。
const STAGE_W = 270;
const STAGE_H = 480;

/** jsdom には ResizeObserver が無い。observe 時に固定サイズを 1 回通知するだけの代替。 */
class FakeResizeObserver {
  constructor(private readonly cb: (entries: { contentRect: DOMRectReadOnly }[]) => void) {}
  observe(): void {
    this.cb([{ contentRect: { width: STAGE_W, height: STAGE_H } as DOMRectReadOnly }]);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

/**
 * フレーム 0 で可視のテロップ 2 件。
 *
 * 以前はフレーム 0 で**非表示**の 2 件（100..400 / 500..800）を使っていたが、
 * サイクル 4 A-4 で「選択中テロップが再生位置の外なら枠とつまみを出さない」
 * 仕様になったため、box 操作を見るテストは可視のテロップで組む必要がある。
 */
function makeTelops(): EditorTelop[] {
  return [
    { id: 1, originalStart: 0, originalEnd: 400, text: 'てろっぷA', template: 1 },
    { id: 2, originalStart: 0, originalEnd: 800, text: 'てろっぷB', template: 1 },
  ];
}

/** フレーム 0 で 2 件とも可視（`.pv-hit` を描かせてクリック選択経路を見る）。 */
function makeVisibleTelops(): EditorTelop[] {
  return [
    { id: 1, originalStart: 0, originalEnd: 400, text: 'てろっぷA', template: 1 },
    { id: 2, originalStart: 0, originalEnd: 400, text: 'てろっぷB', template: 1 },
  ];
}

interface HarnessProps {
  /** 複数選択集合（空なら単一選択）。 */
  multiIds: number[];
  /** onEdit（確定）で受け取った state を記録する。 */
  onCommit: (next: EditState) => void;
  /** テロップ一覧（既定はフレーム 0 で非表示の 2 件）。 */
  telops?: EditorTelop[];
  /** 最新 state を外へ出す（クリック選択の結果を見る）。 */
  onState?: (s: EditState) => void;
  /** TELOP_CONFIG.bottomOffset（枠アンカー）。 */
  telopBottomOffset?: number | null;
}

function Harness({ multiIds, onCommit, telops, onState, telopBottomOffset = null }: HarnessProps) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops: telops ?? makeTelops(),
    selection: { kind: 'telop', id: 1 },
    multiTelopIds: multiIds,
  }));
  const playerRef = useRef<PlayerRef | null>(null);
  onState?.(state);
  return (
    <PreviewOverlay
      compWidth={COMP_W}
      compHeight={COMP_H}
      state={state}
      onLive={setState}
      onEdit={(next) => {
        onCommit(next);
        setState(next);
      }}
      playerRef={playerRef}
      telopBottomOffset={telopBottomOffset}
    />
  );
}

function setup(multiIds: number[], extra?: Partial<HarnessProps>) {
  const commits: EditState[] = [];
  let latest: EditState | null = null;
  const { container } = render(
    <Harness
      multiIds={multiIds}
      onCommit={(s) => commits.push(s)}
      onState={(s) => {
        latest = s;
      }}
      {...extra}
    />,
  );
  return {
    container,
    commits,
    state: (): EditState => {
      if (latest === null) throw new Error('state 未取得');
      return latest;
    },
  };
}

/** 選択中テロップの操作ボックス（既定 position/scale）。 */
function defaultBox() {
  const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
  return telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
}

/** 本体を掴んで右へ dx px 動かして離す。 */
function dragBody(container: HTMLElement, dx: number): void {
  const grab = container.querySelector('.pv-telop-grab');
  expect(grab).not.toBeNull();
  fireEvent.pointerDown(grab as Element, { clientX: 100, clientY: 200 });
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 200 });
  fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 200 });
}

/**
 * 右下ハンドルを掴み、**不動点からの距離**をちょうど 2 倍にして離す（scale ×2）。
 * テロップの拡縮の不動点は 2026-08-19 に「枠中心」→ 実描画の transformOrigin と同じ幾何点
 * （設計書 §1 v2 / レビュー P2-2）へ変わった。この標準フィクスチャでは origin＝anchor なので
 * その点は枠の下端中央と一致する（不動点そのものの検証は「拡縮の不動点は幾何の正本から導出する」
 * の 2 件が担う）。ここが見ているのは「複数選択の全員へ同じ scale が乗るか」。
 */
function dragCornerToDouble(container: HTMLElement): void {
  const handle = container.querySelector('.pv-handle.se');
  expect(handle).not.toBeNull();
  const box = defaultBox();
  const anchorX = box.x + box.w / 2;
  const anchorY = box.y + box.h; // 下端中央
  const cornerX = box.x + box.w;
  const cornerY = box.y + box.h;
  fireEvent.pointerDown(handle as Element, { clientX: cornerX, clientY: cornerY });
  const endX = anchorX + (cornerX - anchorX) * 2;
  const endY = anchorY + (cornerY - anchorY) * 2;
  fireEvent.pointerMove(window, { clientX: endX, clientY: endY });
  fireEvent.pointerUp(window, { clientX: endX, clientY: endY });
}

function telopOf(state: EditState, id: number): EditorTelop {
  const t = state.telops.find((x) => x.id === id);
  if (!t) throw new Error(`telop ${id} not found`);
  return t;
}

afterEach(() => {
  cleanup();
});

describe('複数選択中のプレビュードラッグ', () => {
  it('本体ドラッグ（移動）は選択中の全テロップへ同じ position を適用する', () => {
    const { container, commits } = setup([1, 2]);
    dragBody(container, 40);

    expect(commits).toHaveLength(1);
    const next = commits[0] as EditState;
    // dx=40 → x = 2*40/270 ≒ 0.296 が三分割線 1/3 へ吸着する。
    expect(telopOf(next, 1).position).toEqual({ x: 1 / 3, y: 0 });
    expect(telopOf(next, 2).position).toEqual({ x: 1 / 3, y: 0 });
    // position オブジェクトは参照共有しない（設計書 §3 の ops 契約）。
    expect(telopOf(next, 1).position).not.toBe(telopOf(next, 2).position);
  });

  it('角ハンドルドラッグ（拡縮）は選択中の全テロップへ同じ scale を適用する', () => {
    const { container, commits } = setup([1, 2]);
    dragCornerToDouble(container);

    expect(commits).toHaveLength(1);
    const next = commits[0] as EditState;
    expect(telopOf(next, 1).scale).toBeCloseTo(2, 5);
    expect(telopOf(next, 2).scale).toBeCloseTo(2, 5);
  });

  it('単一選択（集合が空）ならプライマリだけが動く（従来どおり）', () => {
    const { container, commits } = setup([]);
    dragBody(container, 40);

    expect(commits).toHaveLength(1);
    const next = commits[0] as EditState;
    expect(telopOf(next, 1).position).toEqual({ x: 1 / 3, y: 0 });
    expect(telopOf(next, 2).position).toBeUndefined();
  });

  it('単一選択（集合が空）の拡縮はプライマリだけに効く（従来どおり）', () => {
    const { container, commits } = setup([]);
    dragCornerToDouble(container);

    expect(commits).toHaveLength(1);
    const next = commits[0] as EditState;
    expect(telopOf(next, 1).scale).toBeCloseTo(2, 5);
    expect(telopOf(next, 2).scale).toBeUndefined();
  });

  it('動かさずに離しただけ（no-op）なら確定を積まない', () => {
    const { container, commits } = setup([1, 2]);
    const grab = container.querySelector('.pv-telop-grab');
    fireEvent.pointerDown(grab as Element, { clientX: 100, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 200 });
    expect(commits).toHaveLength(0);
  });

  it('ドラッグしたが値が変わらない（同一 state 参照）なら確定を積まない', () => {
    // 既に x=1/3 にいるテロップを、同じ 1/3 へ吸着する量だけ動かす → 値は不変。
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 0, originalEnd: 400, text: 'A', template: 1, position: { x: 1 / 3, y: 0 } },
      { id: 2, originalStart: 0, originalEnd: 800, text: 'B', template: 1, position: { x: 1 / 3, y: 0 } },
    ];
    const { container, commits } = setup([1, 2], { telops });
    // 開始 x=1/3 から dx=+1px（≒0.0074）→ 吸着で 1/3 へ戻る＝値の変化なし。
    dragBody(container, 1);
    expect(commits).toHaveLength(0);
  });
});

describe('プレビュー上のクリック選択（pv-hit）と複数選択の相互作用', () => {
  it('複数選択メンバーの .pv-hit クリックで集合が解除される（誤って全員が動く経路を断つ）', () => {
    const { container, commits, state } = setup([1, 2], { telops: makeVisibleTelops() });
    // 選択中（プライマリ）以外＝ telop 2 のヒット領域が描かれている。
    const hits = container.querySelectorAll('.pv-hit');
    expect(hits).toHaveLength(1);

    fireEvent.pointerDown(hits[0] as Element, { clientX: 100, clientY: 200 });

    // 集合は空・プライマリは telop 2 へ移る。
    expect(state().multiTelopIds).toEqual([]);
    expect(state().selection).toEqual({ kind: 'telop', id: 2 });

    // 続けて本体をドラッグしても telop 1 は巻き込まれない。
    dragBody(container, 40);
    expect(commits).toHaveLength(1);
    const next = commits[0] as EditState;
    expect(telopOf(next, 2).position).toEqual({ x: 1 / 3, y: 0 });
    expect(telopOf(next, 1).position).toBeUndefined();
  });
});

describe('拡縮の不動点は幾何の正本から導出する（レビュー P2-2）', () => {
  /**
   * テロップの不動点（stage ローカル）。実描画の transformOrigin と同じ式で、
   * **枠（実測でも近似でも）からは導出しない**。
   */
  function telopAnchorPoint(position: { x: number; y: number }) {
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    return {
      x: content.x + content.w / 2 + (position.x * content.w) / 2,
      y:
        content.y +
        content.h *
          (telopScaleOriginY(COMP_W, COMP_H) / 100 + position.y * telopVCoeff(COMP_W, COMP_H)),
    };
  }

  /** se ハンドルを掴み、指定の不動点からの距離を k 倍にして離す。 */
  function dragSeAround(
    container: HTMLElement,
    anchor: { x: number; y: number },
    box: { x: number; y: number; w: number; h: number },
    k: number,
  ): void {
    const handle = container.querySelector('.pv-handle.se');
    expect(handle).not.toBeNull();
    const cornerX = box.x + box.w;
    const cornerY = box.y + box.h;
    fireEvent.pointerDown(handle as Element, { clientX: cornerX, clientY: cornerY });
    const endX = anchor.x + (cornerX - anchor.x) * k;
    const endY = anchor.y + (cornerY - anchor.y) * k;
    fireEvent.pointerMove(window, { clientX: endX, clientY: endY });
    fireEvent.pointerUp(window, { clientX: endX, clientY: endY });
  }

  it('標準プロジェクト（origin＝anchor）では不動点からの距離比がそのまま scale になる', () => {
    const { container, commits } = setup([]);
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
    dragSeAround(container, telopAnchorPoint({ x: 0, y: 0 }), box, 2);
    expect(commits).toHaveLength(1);
    expect(telopOf(commits[0] as EditState, 1).scale).toBeCloseTo(2, 5);
  });

  it('bottomOffset=540（origin≠anchor）でも不動点は origin 側（枠の下端ではない）', () => {
    const { container, commits } = setup([], { telopBottomOffset: 540 });
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H, 540);
    const anchor = telopAnchorPoint({ x: 0, y: 0 });
    // 前提: この設定では枠の下端中央と幾何の不動点が食い違う（＝両者を区別できる）。
    expect(Math.abs(box.y + box.h - anchor.y)).toBeGreaterThan(5);

    dragSeAround(container, anchor, box, 2);
    expect(commits).toHaveLength(1);
    // 幾何の不動点から測れば距離はちょうど 2 倍＝ scale 2。
    expect(telopOf(commits[0] as EditState, 1).scale).toBeCloseTo(2, 5);
  });
});

describe('枠アンカーの配線（telopBottomOffset プロップ）', () => {
  it('telopBottomOffset={540} で .pv-telop-box の位置が telopBoxRect(…,540) と一致する', () => {
    const { container } = setup([], { telopBottomOffset: 540 });
    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement | null;
    if (!boxEl) throw new Error('.pv-telop-box が無い');
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const expected = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H, 540);
    expect(boxEl.style.top).toBe(`${expected.y}px`);
    expect(boxEl.style.left).toBe(`${expected.x}px`);
    expect(boxEl.style.height).toBe(`${expected.h}px`);
    // 未指定（標準）とは異なる位置になっている＝プロップが実際に効いている。
    const stdTop = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H).y;
    expect(boxEl.style.top).not.toBe(`${stdTop}px`);
  });

  it('枠が stage 上端より上へ出ても掴み面が stage 内へ残る', () => {
    // bottomOffset=1900（ほぼ画面上端）＋ scale 3 で箱が stage 上端外へ大きくはみ出す。
    const { container } = setup([], { telopBottomOffset: 1900 });
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H, 1900);
    expect(box.y).toBeLessThan(0); // 前提: 箱の上端は stage 外
    const grab = container.querySelector('.pv-telop-grab') as HTMLElement | null;
    if (!grab) throw new Error('.pv-telop-grab が無い（掴めない）');
    // 掴み面の上端（box ローカル）＋ box.y が stage 内（>= 0）に収まる。
    const localTop = parseFloat(grab.style.top || '0');
    expect(box.y + localTop).toBeGreaterThanOrEqual(0);
    expect(parseFloat(grab.style.height)).toBeGreaterThan(0);
  });
});
