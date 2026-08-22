/**
 * @vitest-environment jsdom
 *
 * 図形のプレビュー操作（クリック選択・本体ドラッグ移動・ハンドルでリサイズ）の結線テスト。
 * 設計書: docs/specs/2026-08-19-measured-overlay-box-design.md §2
 *
 * ここは **実 React の pointerdown → pointermove → pointerup を通した結線** を見る。
 * クランプ契約そのもの（平行移動保持・同一参照）は shapeOps.test.ts が担う。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorShape } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { PreviewOverlay } from './PreviewOverlay';

const COMP_W = 1080;
const COMP_H = 1920;
// contain フィットがちょうど 1/4 になる stage サイズ（content = 270×480・レターボックス無し）。
const STAGE_W = 270;
const STAGE_H = 480;

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

/** 正規化座標 → client 座標（content が stage 全面なので係数だけ）。 */
const cx = (nx: number): number => nx * STAGE_W;
const cy = (ny: number): number => ny * STAGE_H;

function shape(over: Partial<EditorShape> & { id: number }): EditorShape {
  return {
    originalStart: 0,
    originalEnd: 200,
    kind: 'rect',
    x1: 0.2,
    y1: 0.2,
    x2: 0.6,
    y2: 0.6,
    color: '#FF3B30',
    thickness: 'medium',
    ...over,
  };
}

interface HarnessProps {
  shapes: EditorShape[];
  selection?: EditState['selection'];
  onCommit?: (s: EditState) => void;
  onState?: (s: EditState) => void;
}

function Harness({ shapes, selection, onCommit, onState }: HarnessProps) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    shapes,
    selection: selection ?? null,
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
        onCommit?.(next);
        setState(next);
      }}
      playerRef={playerRef}
    />
  );
}

function setup(props: HarnessProps) {
  const commits: EditState[] = [];
  let latest: EditState | null = null;
  const { container } = render(
    <Harness
      {...props}
      onCommit={(s) => commits.push(s)}
      onState={(s) => {
        latest = s;
      }}
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

function shapeOf(state: EditState, id: number): EditorShape {
  const s = state.shapes.find((x) => x.id === id);
  if (!s) throw new Error(`shape ${id} not found`);
  return s;
}

afterEach(() => {
  cleanup();
});

describe('図形のヒット領域（可視のみ・後勝ち）', () => {
  it('現在フレームで可視の図形だけヒット領域を出す', () => {
    const { container } = setup({
      shapes: [
        shape({ id: 1 }),
        shape({ id: 2, originalStart: 500, originalEnd: 600 }), // フレーム 0 では不可視
      ],
    });
    const hits = container.querySelectorAll('[data-sme-shape-hit]');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.getAttribute('data-sme-shape-hit')).toBe('1');
  });

  it('重なる図形は描画順の後ろが上に来る（後勝ち＝上に見えるものが選ばれる）', () => {
    const { container } = setup({
      shapes: [shape({ id: 1 }), shape({ id: 2 })],
    });
    const hits = Array.from(container.querySelectorAll('[data-sme-shape-hit]'));
    // DOM 順＝描画順。SVG は後の要素が上に描かれ、そのままヒットも後勝ちになる。
    expect(hits.map((h) => h.getAttribute('data-sme-shape-hit'))).toEqual(['1', '2']);
  });

  it('線・矢印はヒット帯（線分距離）を持ち、矩形・楕円は内部でヒットする', () => {
    const { container } = setup({
      shapes: [
        shape({ id: 1, kind: 'line' }),
        shape({ id: 2, kind: 'ellipse' }),
        shape({ id: 3, kind: 'rect' }),
      ],
    });
    const line = container.querySelector('[data-sme-shape-hit="1"]')!;
    expect(line.tagName.toLowerCase()).toBe('line');
    // 線は「点と線分の距離」判定＝太さ＋マージン帯（bbox 全域ではない）。
    expect(Number(line.getAttribute('stroke-width'))).toBeGreaterThan(0);
    expect(container.querySelector('[data-sme-shape-hit="2"]')!.tagName.toLowerCase()).toBe('ellipse');
    expect(container.querySelector('[data-sme-shape-hit="3"]')!.tagName.toLowerCase()).toBe('rect');
  });

  it('ヒット領域の pointerdown で図形が選択される', () => {
    const { container, state } = setup({ shapes: [shape({ id: 4 })] });
    fireEvent.pointerDown(container.querySelector('[data-sme-shape-hit="4"]')!, {
      clientX: cx(0.4),
      clientY: cy(0.4),
    });
    expect(state().selection).toEqual({ kind: 'shape', id: 4 });
  });
});

describe('図形の選択枠とハンドル', () => {
  it('矩形は論理端点の組合せ 4 点、線は 2 点のハンドルを出す', () => {
    const rect = setup({ shapes: [shape({ id: 1 })], selection: { kind: 'shape', id: 1 } });
    expect(rect.container.querySelector('.pv-shape-box')).not.toBeNull();
    expect(rect.container.querySelectorAll('.pv-shape-handle')).toHaveLength(4);
    cleanup();

    const line = setup({
      shapes: [shape({ id: 1, kind: 'arrow' })],
      selection: { kind: 'shape', id: 1 },
    });
    expect(line.container.querySelectorAll('.pv-shape-handle')).toHaveLength(2);
  });

  it('選択枠は幾何データ由来の座標に出る（実測不要）', () => {
    const { container } = setup({
      shapes: [shape({ id: 1, x1: 0.2, y1: 0.25, x2: 0.6, y2: 0.75 })],
      selection: { kind: 'shape', id: 1 },
    });
    const boxEl = container.querySelector('.pv-shape-box') as HTMLElement;
    expect(boxEl.style.left).toBe(`${cx(0.2)}px`);
    expect(boxEl.style.top).toBe(`${cy(0.25)}px`);
    expect(boxEl.style.width).toBe(`${cx(0.4)}px`);
    expect(boxEl.style.height).toBe(`${cy(0.5)}px`);
  });

  it('不可視フレームの図形は選択中でも枠を出さない', () => {
    const { container } = setup({
      shapes: [shape({ id: 1, originalStart: 500, originalEnd: 600 })],
      selection: { kind: 'shape', id: 1 },
    });
    expect(container.querySelector('.pv-shape-box')).toBeNull();
  });
});

describe('図形の本体ドラッグ（移動）', () => {
  it('平行移動して確定を 1 件だけ積む（1 ドラッグ 1 Undo）', () => {
    const { container, commits } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const hit = container.querySelector('[data-sme-shape-hit="1"]')!;
    fireEvent.pointerDown(hit, { clientX: cx(0.4), clientY: cy(0.4) });
    fireEvent.pointerMove(window, { clientX: cx(0.4) + cx(0.1), clientY: cy(0.4) + cy(0.1) });
    fireEvent.pointerUp(window, { clientX: cx(0.4) + cx(0.1), clientY: cy(0.4) + cy(0.1) });

    expect(commits).toHaveLength(1);
    const s = shapeOf(commits[0]!, 1);
    expect(s.x1).toBeCloseTo(0.3, 5);
    expect(s.y1).toBeCloseTo(0.3, 5);
    expect(s.x2).toBeCloseTo(0.7, 5);
    expect(s.y2).toBeCloseTo(0.7, 5);
  });

  it('境界を越えて引いても大きさは変わらない（平行移動を保つ）', () => {
    const { container, commits } = setup({
      shapes: [shape({ id: 1, x1: 0.2, y1: 0.2, x2: 0.6, y2: 0.6 })],
      selection: { kind: 'shape', id: 1 },
    });
    const hit = container.querySelector('[data-sme-shape-hit="1"]')!;
    fireEvent.pointerDown(hit, { clientX: cx(0.4), clientY: cy(0.4) });
    fireEvent.pointerMove(window, { clientX: cx(0.4) - cx(0.9), clientY: cy(0.4) });
    fireEvent.pointerUp(window, { clientX: cx(0.4) - cx(0.9), clientY: cy(0.4) });

    const s = shapeOf(commits[0]!, 1);
    expect(s.x1).toBeCloseTo(0, 5);
    expect(s.x2).toBeCloseTo(0.4, 5); // 幅 0.4 が保たれる
  });

  it('動かさずに離しただけなら確定を積まない（no-op）', () => {
    const { container, commits, state } = setup({ shapes: [shape({ id: 1 })] });
    const hit = container.querySelector('[data-sme-shape-hit="1"]')!;
    fireEvent.pointerDown(hit, { clientX: cx(0.4), clientY: cy(0.4) });
    fireEvent.pointerUp(window, { clientX: cx(0.4), clientY: cy(0.4) });
    expect(commits).toHaveLength(0);
    // 選択だけは反映される（履歴は積まない）。
    expect(state().selection).toEqual({ kind: 'shape', id: 1 });
  });
});

describe('図形のハンドルドラッグ（リサイズ）', () => {
  it('掴んだ端点の成分だけを更新する（setShapePoints 経路）', () => {
    const { container, commits } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const handle = container.querySelector('[data-sme-shape-handle="x1y1"]')!;
    fireEvent.pointerDown(handle, { clientX: cx(0.2), clientY: cy(0.2) });
    fireEvent.pointerMove(window, { clientX: cx(0.3), clientY: cy(0.35) });
    fireEvent.pointerUp(window, { clientX: cx(0.3), clientY: cy(0.35) });

    expect(commits).toHaveLength(1);
    const s = shapeOf(commits[0]!, 1);
    expect(s.x1).toBeCloseTo(0.3, 5);
    expect(s.y1).toBeCloseTo(0.35, 5);
    expect(s.x2).toBeCloseTo(0.6, 5);
    expect(s.y2).toBeCloseTo(0.6, 5);
  });

  it('交差する位置まで引いても破綻しない（端点の役割交換を許す）', () => {
    const { container, commits } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const handle = container.querySelector('[data-sme-shape-handle="x2y2"]')!;
    fireEvent.pointerDown(handle, { clientX: cx(0.6), clientY: cy(0.6) });
    fireEvent.pointerMove(window, { clientX: cx(0.05), clientY: cy(0.05) });
    fireEvent.pointerUp(window, { clientX: cx(0.05), clientY: cy(0.05) });

    const s = shapeOf(commits[0]!, 1);
    expect(s.x2).toBeCloseTo(0.05, 5);
    expect(s.y2).toBeCloseTo(0.05, 5);
    expect(s.x1).toBeCloseTo(0.2, 5);
  });

  it('掴んだ位置が端点からずれていてもオフセットを保つ（差分ベース）', () => {
    // ハンドルは 12px の円。中心ちょうどを掴めるとは限らない。絶対座標マッピングだと
    // 掴んだ瞬間に端点がポインタへ飛び、動かしていないのに図形が変形する（レビュー P2-3）。
    const { container, commits } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const handle = container.querySelector('[data-sme-shape-handle="x1y1"]')!;
    // 端点 (0.2,0.2) から 5px ずれた位置で掴み、そこから右へ 27px（=0.1）動かす。
    fireEvent.pointerDown(handle, { clientX: cx(0.2) + 5, clientY: cy(0.2) + 5 });
    fireEvent.pointerMove(window, { clientX: cx(0.2) + 5 + cx(0.1), clientY: cy(0.2) + 5 });
    fireEvent.pointerUp(window, { clientX: cx(0.2) + 5 + cx(0.1), clientY: cy(0.2) + 5 });

    expect(commits).toHaveLength(1);
    const s = shapeOf(commits[0]!, 1);
    // 掴んだオフセット（5px）は結果に混入せず、移動量ぶんだけ動く。
    expect(s.x1).toBeCloseTo(0.3, 5);
    expect(s.y1).toBeCloseTo(0.2, 5);
  });

  it('端点から少しずれた位置での純クリック（down→up）は完全な no-op で確定を積まない', () => {
    const { container, commits, state } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const handle = container.querySelector('[data-sme-shape-handle="x2y2"]')!;
    fireEvent.pointerDown(handle, { clientX: cx(0.6) + 5, clientY: cy(0.6) - 5 });
    fireEvent.pointerUp(window, { clientX: cx(0.6) + 5, clientY: cy(0.6) - 5 });
    expect(commits).toHaveLength(0);
    // 座標も一切動かない。
    const s = shapeOf(state(), 1);
    expect(s.x2).toBeCloseTo(0.6, 5);
    expect(s.y2).toBeCloseTo(0.6, 5);
  });

  it('ハンドルを動かさなければ確定を積まない（no-op）', () => {
    const { container, commits } = setup({
      shapes: [shape({ id: 1 })],
      selection: { kind: 'shape', id: 1 },
    });
    const handle = container.querySelector('[data-sme-shape-handle="x1y1"]')!;
    fireEvent.pointerDown(handle, { clientX: cx(0.2), clientY: cy(0.2) });
    fireEvent.pointerUp(window, { clientX: cx(0.2), clientY: cy(0.2) });
    expect(commits).toHaveLength(0);
  });
});
