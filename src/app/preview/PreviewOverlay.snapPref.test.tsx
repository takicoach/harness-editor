/**
 * @vitest-environment jsdom
 *
 * プレビュー上の位置ドラッグにも、タイムラインと同じ吸着トグル／Alt 一時解除が効く
 * （監査 interaction-7）。以前はプレビューだけ `snapPosition` を無条件に掛けており、
 * 「中央から少しだけずらす」がプレビューでは一切できなかった。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import type { EditorTelop } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { PreviewOverlay } from './PreviewOverlay';
import type { SnapPref } from '../useSnapPref';

const COMP_W = 1080;
const COMP_H = 1920;
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

const TELOPS: EditorTelop[] = [
  { id: 1, originalStart: 0, originalEnd: 400, text: 'A', template: 1, position: { x: 0, y: 0 } },
];

function Harness({ pref, onState }: { pref?: SnapPref; onState: (s: EditState) => void }) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops: TELOPS,
    selection: { kind: 'telop', id: 1 },
  }));
  const playerRef = useRef<PlayerRef | null>({
    seekTo: vi.fn(),
    addEventListener() {},
    removeEventListener() {},
    getCurrentFrame: () => 0,
    isPlaying: () => false,
  } as unknown as PlayerRef);
  onState(state);
  return (
    <div style={{ width: STAGE_W, height: STAGE_H }}>
      <PreviewOverlay
        compWidth={COMP_W}
        compHeight={COMP_H}
        state={state}
        onLive={setState}
        onEdit={setState}
        playerRef={playerRef}
        {...(pref === undefined ? {} : { snapPref: pref })}
      />
    </div>
  );
}

/** x=0 から数 px だけ横へ動かす（吸着 ON なら 0 に吸い戻される量）。 */
function dragSlightly(container: HTMLElement): void {
  const grab = container.querySelector('.pv-telop-grab') as Element;
  fireEvent.pointerDown(grab, { clientX: 100, clientY: 200 });
  fireEvent.pointerMove(window, { clientX: 102, clientY: 200 });
  fireEvent.pointerUp(window, { clientX: 102, clientY: 200 });
}

function makePref(snapEnabled: boolean, altHeld: boolean): SnapPref {
  return { snapEnabled, setSnapEnabled: () => {}, altHeldRef: { current: altHeld } };
}

afterEach(cleanup);

/** ドラッグ後のテロップの x（正規化）。 */
function finalX(pref?: SnapPref): number {
  let last: EditState | null = null;
  const { container } = render(
    <Harness {...(pref === undefined ? {} : { pref })} onState={(s) => (last = s)} />,
  );
  dragSlightly(container);
  const state = last as EditState | null;
  return state?.telops[0]?.position?.x ?? Number.NaN;
}

describe('プレビューの吸着（interaction-7）', () => {
  it('吸着 ON では中央（0）へ吸い戻る', () => {
    expect(finalX(makePref(true, false))).toBe(0);
  });

  it('吸着トグル OFF なら中央から少しだけずらせる', () => {
    expect(finalX(makePref(false, false))).not.toBe(0);
  });

  it('ドラッグ中の Alt でも一時解除できる（タイムラインと同じ修飾キー）', () => {
    expect(finalX(makePref(true, true))).not.toBe(0);
  });

  it('snapPref 未配線なら従来どおり常時吸着（後方互換）', () => {
    expect(finalX()).toBe(0);
  });
});
