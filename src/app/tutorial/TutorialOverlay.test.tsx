/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TutorialOverlay } from './TutorialOverlay';
import type { TutorialStep } from './tutorialSteps';
import type { TutorialApi } from './useTutorial';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

function api(step: TutorialStep): TutorialApi {
  return {
    active: true, step, index: 2, total: 5,
    ctx: { home: false, hasProjects: true, editorReady: true, telopCount: 0, dirty: false, domHas: () => false },
    next: vi.fn(), skip: vi.fn(), close: vi.fn(), start: vi.fn(),
  };
}
const TARGETED: TutorialStep = { id: 'save', target: '#target', text: '保存の説明' };
const TRY: TutorialStep = { id: 'telop-try', target: '#target', text: '押してください', nextButton: false };
const RECT = { left: 100, top: 50, right: 180, bottom: 90, width: 80, height: 40 };

function placeTarget(): void {
  const el = document.createElement('button');
  el.id = 'target';
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ ...RECT, x: RECT.left, y: RECT.top, toJSON: () => ({}) }) });
  document.body.append(el);
}

describe('旧画面（追加指定なし）は従来どおり', () => {
  it('対象を querySelector で探して周囲 6px をくり抜き、data-target / data-waiting は付けない', () => {
    placeTarget();
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} />);
    const hole = view.container.querySelector<HTMLElement>('.tut-hole')!;
    expect(hole.style.left).toBe('94px');
    expect(hole.style.top).toBe('44px');
    expect(hole.style.width).toBe('92px');
    const root = view.container.querySelector('.tut')!;
    expect(root.hasAttribute('data-target')).toBe(false);
    expect(root.hasAttribute('data-waiting')).toBe(false);
    expect(view.getByText('保存の説明')).toBeTruthy();
    expect(view.getByRole('button', { name: 'スキップ' })).toBeTruthy();
    expect(view.getByRole('button', { name: '次へ' })).toBeTruthy();
  });
  it('対象が無ければ中央表示（暗幕のみ）', () => {
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} />);
    expect(view.container.querySelector('.tut-dim')).not.toBeNull();
    expect(view.container.querySelector('.tut-hole')).toBeNull();
  });
  it('nextButton:false の手順は「次へ」を出さない', () => {
    placeTarget();
    const view = render(<TutorialOverlay tutorial={api(TRY)} />);
    expect(view.queryByRole('button', { name: '次へ' })).toBeNull();
  });
});

describe('新画面の追加指定', () => {
  it('hidden の間は何も描かない', () => {
    placeTarget();
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} options={{ hidden: true }} />);
    expect(view.container.innerHTML).toBe('');
  });
  it('band は最前面の1行案内帯だけを出し、暗幕・吹き出しは出さない', () => {
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} options={{ band: '名前を確かめて「作成」' }} />);
    const band = view.container.querySelector('.tut-band')!;
    expect(band.getAttribute('data-step')).toBe('save');
    expect(band.getAttribute('role')).toBe('status');
    expect(band.textContent).toBe('名前を確かめて「作成」');
    expect(view.container.querySelector('.tut')).toBeNull();
    expect(view.container.querySelector('.tut-bubble')).toBeNull();
  });
  it('waiting は暗幕なしで待ちの文を出し、「次へ」「スキップ」は出さず × は残す', () => {
    placeTarget();
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} options={{ waiting: '読み込み中…' }} />);
    const root = view.container.querySelector('.tut')!;
    expect(root.getAttribute('data-waiting')).toBe('true');
    expect(root.hasAttribute('data-target')).toBe(false);
    expect(view.container.querySelector('.tut-dim')).toBeNull();
    expect(view.container.querySelector('.tut-hole')).toBeNull();
    expect(view.getByText('読み込み中…')).toBeTruthy();
    expect(view.queryByRole('button', { name: '次へ' })).toBeNull();
    expect(view.queryByRole('button', { name: 'スキップ' })).toBeNull();
    expect(view.getByRole('button', { name: 'チュートリアルを閉じる' })).toBeTruthy();
  });
  it('locate の矩形を照らし、照準セレクタを data-target に出す', () => {
    const locate = vi.fn(() => RECT);
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} options={{ locate, unavailableText: '見えません' }} />);
    expect(locate).toHaveBeenCalledWith('#target');
    expect(view.container.querySelector<HTMLElement>('.tut-hole')!.style.left).toBe('94px');
    expect(view.container.querySelector('.tut')!.getAttribute('data-target')).toBe('#target');
    expect(view.getByText('保存の説明')).toBeTruthy();
  });
  it('locate が null（見えない・押せない）なら中央に unavailableText を出し、「次へ」を必ず出す', () => {
    const tutorial = api(TRY);
    const view = render(<TutorialOverlay tutorial={tutorial} options={{ locate: () => null, unavailableText: 'この部品は今の画面では表示されていません' }} />);
    // 新画面は .tut-dim ではなく、画面全体に広げた .tut-hole--full で暗幕を表す（.tut-dim との入れ替えを無くし、切り替えを滑らかにするため）。
    expect(view.container.querySelector('.tut-hole--full')).not.toBeNull();
    expect(view.getByText('この部品は今の画面では表示されていません')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '次へ' }));
    expect(tutorial.next).toHaveBeenCalledOnce();
  });
  it('新画面だけ tut-native が付き、暗幕は .tut-dim ではなく画面全体に広げた .tut-hole--full で表す（旧画面との切り替えを滑らかにするため）', () => {
    const view = render(<TutorialOverlay tutorial={api(TRY)} options={{ locate: () => null }} />);
    expect(view.container.querySelector('.tut')!.classList.contains('tut-native')).toBe(true);
    expect(view.container.querySelector('.tut-dim')).toBeNull();
    const hole = view.container.querySelector<HTMLElement>('.tut-hole.tut-hole--full')!;
    expect(hole).not.toBeNull();
    expect(hole.style.left).toBe('0px');
    expect(hole.style.top).toBe('0px');
  });
  it('照準がある手順では tut-native でも tut-hole--full は付かず、通常のくり抜き矩形になる', () => {
    const locate = vi.fn(() => RECT);
    const view = render(<TutorialOverlay tutorial={api(TARGETED)} options={{ locate }} />);
    const hole = view.container.querySelector<HTMLElement>('.tut-hole')!;
    expect(hole.classList.contains('tut-hole--full')).toBe(false);
    expect(hole.style.left).toBe('94px');
  });
});
