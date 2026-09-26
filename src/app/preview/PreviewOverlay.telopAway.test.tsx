/**
 * @vitest-environment jsdom
 *
 * 選択中のテロップが再生位置の外にいるとき、空の枠を描かない（サイクル 4 A-4）。
 *
 * `after/c1/17b-conflict-after-fix.png`: 1:33〜1:36 のテロップを選んだまま 0:00 にいると、
 * 何も映っていない場所に選択枠とつまみだけが浮いていた。掴んでも何が動いているのか
 * 分からず、拡縮つまみは「見えないもの」を拡大する操作になる。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import type { CutRegion, EditorTelop } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { PreviewOverlay } from './PreviewOverlay';

const COMP_W = 1080;
const COMP_H = 1920;
const STAGE_W = 270;
const STAGE_H = 480;
const FPS = 30;

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

/** 1:33〜1:36（30fps）に出るテロップ。フレーム 0 では出ていない。 */
const AWAY: EditorTelop[] = [
  { id: 1, originalStart: 2790, originalEnd: 2880, text: '遠いテロップ', template: 1 },
];
/** フレーム 0 で出ているテロップ。 */
const HERE: EditorTelop[] = [
  { id: 1, originalStart: 0, originalEnd: 400, text: '今のテロップ', template: 1 },
];

const seekTo = vi.fn();
const pause = vi.fn();

function Harness({
  telops,
  cutRegions = [],
  cutsBypassed = false,
}: {
  telops: EditorTelop[];
  cutRegions?: CutRegion[];
  cutsBypassed?: boolean;
}) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops,
    cutRegions,
    selection: { kind: 'telop', id: 1 },
  }));
  const playerRef = useRef<PlayerRef | null>({
    seekTo,
    pause,
    addEventListener() {},
    removeEventListener() {},
    getCurrentFrame: () => 0,
    isPlaying: () => false,
  } as unknown as PlayerRef);
  return (
    <div style={{ width: STAGE_W, height: STAGE_H }}>
      <PreviewOverlay
        compWidth={COMP_W}
        compHeight={COMP_H}
        state={state}
        onLive={setState}
        onEdit={setState}
        playerRef={playerRef}
        fps={FPS}
        cutsBypassed={cutsBypassed}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  seekTo.mockReset();
  pause.mockReset();
});

describe('選択中テロップが再生位置の外（A-4）', () => {
  it('枠とつまみを出さない', () => {
    const { container } = render(<Harness telops={AWAY} />);
    expect(container.querySelector('.pv-telop-box')).toBeNull();
    expect(container.querySelector('.pv-telop-grab')).toBeNull();
    expect(container.querySelector('.pv-handle')).toBeNull();
  });

  it('代わりに「いつ表示されるか」を案内する', () => {
    const { container } = render(<Harness telops={AWAY} />);
    const away = container.querySelector('.pv-telop-away');
    expect(away).not.toBeNull();
    // 2790/30 = 93 秒 = 1:33、2880/30 = 96 秒 = 1:36。
    expect(away?.textContent).toContain('1:33');
    expect(away?.textContent).toContain('1:36');
    expect(away?.textContent).toContain('表示されます');
  });

  it('「そこへ移動」で再生を止め、テロップの中央へ動かす', () => {
    const { container } = render(<Harness telops={AWAY} />);
    const goto = container.querySelector('[data-testid="preview-telop-goto"]');
    expect(goto).not.toBeNull();
    fireEvent.click(goto as Element);
    // カット無し・速度 1 なら原本＝再生＝プレイヤー座標。
    expect(pause).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(2835);
  });

  it('「カットも再生」中はカット後座標へ戻さず、原本上の中央へ動かす', () => {
    const { container } = render(
      <Harness telops={AWAY} cutRegions={[{ start: 0, end: 2700 }]} cutsBypassed />,
    );
    fireEvent.click(container.querySelector('[data-testid="preview-telop-goto"]') as Element);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(2835);
  });

  it('再生位置がテロップの区間内なら従来どおり枠とつまみを出す', () => {
    const { container } = render(<Harness telops={HERE} />);
    expect(container.querySelector('.pv-telop-box')).not.toBeNull();
    expect(container.querySelector('.pv-telop-grab')).not.toBeNull();
    expect(container.querySelectorAll('.pv-handle')).toHaveLength(4);
    expect(container.querySelector('.pv-telop-away')).toBeNull();
  });

  it('区間の末尾フレームは「外」（描画は originalEnd の手前まで）', () => {
    const { container } = render(
      <Harness telops={[{ id: 1, originalStart: 0, originalEnd: 0, text: '幅ゼロ', template: 1 }]} />,
    );
    expect(container.querySelector('.pv-telop-away')).not.toBeNull();
  });
});

describe('案内文の時刻はインスペクタと同じ基準（サイクル 4 レビュー Important）', () => {
  /**
   * 44b-telop-away.png: 完成尺 3:18 の動画を見ているのに案内は「1:46〜2:10」＝原本（カット前）
   * の時刻だけを、断りなく出していた。インスペクタは同じテロップを「0:08〜0:24 ／
   * カット前: 1:46〜2:10」と出しており、同一画面で同じテロップの時刻が 2 通り読めた。
   */
  it('カット済みなら主が完成尺・副が「カット前」になる', () => {
    // 0〜2700 をカット。テロップ 2790〜2880 は完成尺で 90〜180（0:03〜0:06）。
    const { container } = render(
      <Harness telops={AWAY} cutRegions={[{ start: 0, end: 2700 }]} />,
    );
    const text = container.querySelector('.pv-telop-away')?.textContent ?? '';
    expect(text, '主の時刻は完成尺（カット後）').toContain('0:03 〜 0:06');
    expect(text, 'カット前の時刻には必ず断りを付ける').toContain('カット前 1:33 〜 1:36');
    // 断りの無い原本時刻が主として出ていないこと（旧実装の絵）。
    expect(text.startsWith('このテロップは 1:33')).toBe(false);
  });

  it('カット無しなら完成尺＝カット前なので併記しない', () => {
    const { container } = render(<Harness telops={AWAY} />);
    const text = container.querySelector('.pv-telop-away')?.textContent ?? '';
    expect(text).toContain('1:33 〜 1:36');
    expect(text).not.toContain('カット前');
  });
});
