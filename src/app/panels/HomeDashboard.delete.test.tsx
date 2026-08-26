/**
 * @vitest-environment jsdom
 */
/**
 * ホームのプロジェクトカードに出る削除導線（ゴミ箱アイコン）の結線テスト。
 * 実機フィードバック: 進行ボードのカードからも削除したい。導線はホーム一覧側と共有し、
 * 削除ロジック（TrashConfirmDialog → deleteProjectRequest）は 1 本のまま増やさない。
 * カードは D&D で列間移動するため、アイコンの操作がドラッグ開始・カードを開く操作を
 * 誘発しないことを合わせて固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from './HomeDashboard';
import { saveHomeView } from './homeViewPref';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const PROJECT: ProjectSummary = {
  id: 'proj-a',
  name: 'proj-a',
  orientation: 'v',
  durationLabel: '1:00',
  sizeLabel: '1 MB',
  videoFile: null,
  status: 'telop',
  steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
} as ProjectSummary;

/** dataTransfer 付きの dragstart を要素へ発火する（jsdom は DataTransfer を持たない）。 */
function fireDragStart(el: HTMLElement) {
  const setData = vi.fn();
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } });
  el.dispatchEvent(event);
  return { event, setData };
}

function renderHome(view: 'panel' | 'kanban') {
  saveHomeView(view);
  const onPick = vi.fn();
  render(
    <HomeDashboard
      projects={[PROJECT]}
      error={null}
      onPick={onPick}
      onSetStage={vi.fn()}
      onCreate={vi.fn()}
      onProjectsChanged={vi.fn()}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
  return { onPick };
}

describe('プロジェクトカードの削除アイコン', () => {
  it.each(['kanban', 'panel'] as const)('%s ビューのカードにゴミ箱アイコンが出る', (view) => {
    renderHome(view);
    const btn = screen.getByRole('button', { name: 'ゴミ箱へ移動' });
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('クリックで削除確認ダイアログが開き、カードは開かない（進行ボード）', () => {
    const { onPick } = renderHome('kanban');
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' }));
    expect(screen.getByTestId('trash-confirm-dialog')).toBeTruthy();
    expect(screen.getByText('「proj-a」をゴミ箱へ移動します。あとで復元できます。')).toBeTruthy();
    // カードの onClick へ伝播していない（誤って編集画面へ遷移しない）。
    expect(onPick).not.toHaveBeenCalled();
  });

  it('アイコンの上ではドラッグを始めない（列間 D&D と干渉しない）', () => {
    renderHome('kanban');
    const btn = screen.getByRole('button', { name: 'ゴミ箱へ移動' });
    const card = btn.closest('.home-card');
    expect(card).not.toBeNull();
    // アイコン自身は draggable ではない。
    expect(btn.getAttribute('draggable')).toBe('false');
    // 実ブラウザでは dragstart は draggable 祖先（＝カード）で発火し、アイコンでは発火しない。
    // よって「アイコン上で pointerdown → カードで dragstart」を再現し、カード側のドラッグ開始
    // （dataTransfer へプロジェクト ID を載せる処理）が抑止されることを固定する。
    fireEvent.pointerDown(btn);
    const dragstart = fireDragStart(card as HTMLElement);
    expect(dragstart.event.defaultPrevented).toBe(true);
    expect(dragstart.setData).not.toHaveBeenCalled();
  });

  it('アイコン以外から掴んだカードは通常どおりドラッグできる（抑止が居座らない）', () => {
    renderHome('kanban');
    const btn = screen.getByRole('button', { name: 'ゴミ箱へ移動' });
    const card = btn.closest('.home-card') as HTMLElement;
    // 一度アイコンを押して抑止フラグを立ててから、カード本体を掴み直す。
    fireEvent.pointerDown(btn);
    fireEvent.pointerDown(card);
    const dragstart = fireDragStart(card);
    expect(dragstart.event.defaultPrevented).toBe(false);
    expect(dragstart.setData).toHaveBeenCalledWith('application/x-sme-project', 'proj-a');
  });

  it('アイコンを押して離したら抑止は解除される（次のドラッグに居座らない）', () => {
    renderHome('kanban');
    const btn = screen.getByRole('button', { name: 'ゴミ箱へ移動' });
    const card = btn.closest('.home-card') as HTMLElement;
    // アイコン上での pointerdown → pointerup（＝ドラッグせずクリックした）で 1 ジェスチャ終了。
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    const dragstart = fireDragStart(card);
    expect(dragstart.event.defaultPrevented).toBe(false);
    expect(dragstart.setData).toHaveBeenCalledWith('application/x-sme-project', 'proj-a');
  });

  it('ステータスバッジのボタンから掴んでもカードはドラッグできる', () => {
    renderHome('kanban');
    const btn = screen.getByRole('button', { name: 'ゴミ箱へ移動' });
    const card = btn.closest('.home-card') as HTMLElement;
    const badge = card.querySelector('.home-card-badge-wrap button') as HTMLElement;
    expect(badge).not.toBeNull();
    // 直前に削除アイコンを触っていても、バッジ側の pointerdown は抑止対象ではない。
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.pointerDown(badge);
    const dragstart = fireDragStart(card);
    expect(dragstart.event.defaultPrevented).toBe(false);
    expect(dragstart.setData).toHaveBeenCalledWith('application/x-sme-project', 'proj-a');
  });

  it('確認ダイアログのキャンセルで閉じ、削除 API は呼ばれない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHome('kanban');
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('trash-confirm-dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
