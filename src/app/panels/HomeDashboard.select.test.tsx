/**
 * @vitest-environment jsdom
 */
/**
 * 進行ボードの「選択」モードと一括ゴミ箱移動の結線テスト。
 * 実機フィードバック: 除外したい動画をポチポチ選んで一括で片付けたい。
 * 削除の実体は既存の DELETE /api/project（deleteProjectRequest）1 本のままで、
 * 一括側はそれを逐次呼ぶだけにする（削除ロジックを複製しない）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from './HomeDashboard';
import { saveHomeView } from './homeViewPref';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function project(id: string): ProjectSummary {
  return {
    id,
    name: id,
    orientation: 'v',
    durationLabel: '1:00',
    sizeLabel: '1 MB',
    videoFile: null,
    status: 'telop',
    steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
  } as ProjectSummary;
}

const PROJECTS = [project('proj-a'), project('proj-b'), project('proj-c')];

function fireDragStart(el: HTMLElement) {
  const setData = vi.fn();
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } });
  el.dispatchEvent(event);
  return { event, setData };
}

function renderHome(view: 'panel' | 'kanban' = 'kanban') {
  saveHomeView(view);
  const onPick = vi.fn();
  const onProjectsChanged = vi.fn();
  render(
    <HomeDashboard
      projects={PROJECTS}
      error={null}
      onPick={onPick}
      onSetStage={vi.fn()}
      onCreate={vi.fn()}
      onProjectsChanged={onProjectsChanged}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
  return { onPick, onProjectsChanged };
}

/** 選択モードに入る。 */
function enterSelectMode(): void {
  fireEvent.click(screen.getByRole('button', { name: '選択' }));
}

function card(name: string): HTMLElement {
  return screen.getByText(name).closest('.home-card') as HTMLElement;
}

/** DELETE /api/project の成功応答を返す fetch スパイ。 */
function mockDelete(failFor: string[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    if (failFor.includes(id)) {
      return new Response(JSON.stringify({ error: 'busy', jobs: ['render'] }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ entry: { id: 'x', kind: 'project', name: id, originalPath: id, deletedAt: '' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('進行ボードの選択モード', () => {
  it('「選択」ボタンで選択モードに入り、カードにチェックボックスとアクションバーが出る', () => {
    renderHome();
    expect(screen.queryByTestId('home-select-bar')).toBeNull();
    enterSelectMode();
    expect(screen.getByTestId('home-select-bar')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '選択' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('選択モード中のカードクリックは選択トグルで、プロジェクトを開かない', () => {
    const { onPick } = renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    expect(onPick).not.toHaveBeenCalled();
    expect(card('proj-a').classList.contains('selected')).toBe(true);
    expect(screen.getByTestId('home-select-bar').textContent).toContain('1 件選択中');
    // もう一度押すと外れる
    fireEvent.click(card('proj-a'));
    expect(card('proj-a').classList.contains('selected')).toBe(false);
  });

  it('選択モード中はカードの D&D が発動しない', () => {
    renderHome();
    enterSelectMode();
    const el = card('proj-a');
    expect(el.getAttribute('draggable')).toBe('false');
    const dragstart = fireDragStart(el);
    expect(dragstart.event.defaultPrevented).toBe(true);
    expect(dragstart.setData).not.toHaveBeenCalled();
  });

  it('選択 0 件では「ゴミ箱へ移動」を押せない', () => {
    renderHome();
    enterSelectMode();
    const bar = screen.getByTestId('home-select-bar');
    const move = within(bar).getByRole('button', { name: 'ゴミ箱へ移動' });
    expect(move.hasAttribute('disabled')).toBe(true);
  });

  it('2 件選んで一括移動すると、確認のうえ DELETE が逐次 2 回飛び、一覧が更新される', async () => {
    const fetchSpy = mockDelete();
    const { onProjectsChanged } = renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(card('proj-c'));

    const bar = screen.getByTestId('home-select-bar');
    expect(bar.textContent).toContain('2 件選択中');
    fireEvent.click(within(bar).getByRole('button', { name: 'ゴミ箱へ移動' }));

    const dialog = screen.getByTestId('trash-confirm-dialog');
    expect(dialog.textContent).toContain('2 件');
    expect(dialog.textContent).toContain('proj-a');
    expect(dialog.textContent).toContain('proj-c');
    // 既定フォーカスはキャンセル（既存の作法）。
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBe(document.activeElement);

    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalled());

    const ids = fetchSpy.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost').searchParams.get('id'));
    expect(ids).toEqual(['proj-a', 'proj-c']);
    expect(fetchSpy.mock.calls.every((c) => (c[1] as RequestInit).method === 'DELETE')).toBe(true);
    // 成功後は選択モードが解除される
    await waitFor(() => expect(screen.queryByTestId('home-select-bar')).toBeNull());
    expect(screen.getByTestId('home-bulk-notice').textContent).toContain('2 件をゴミ箱へ移動しました');
  });

  it('busy で失敗した項目はスキップして続行し、理由つきで通知する', async () => {
    mockDelete(['proj-b']);
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(card('proj-b'));
    fireEvent.click(within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'ゴミ箱へ移動' }));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));

    const notice = await screen.findByTestId('home-bulk-notice');
    expect(notice.textContent).toContain('1 件をゴミ箱へ移動しました');
    expect(notice.textContent).toContain('1 件はスキップしました');
    expect(notice.textContent).toContain('proj-b');
  });

  it('全件がスキップされたら選択モードを抜けない（やり直せる）', async () => {
    mockDelete(['proj-a', 'proj-b']);
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(card('proj-b'));
    fireEvent.click(within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'ゴミ箱へ移動' }));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));

    const notice = await screen.findByTestId('home-bulk-notice');
    expect(notice.textContent).toContain('0 件をゴミ箱へ移動しました');
    expect(screen.getByTestId('home-select-bar').textContent).toContain('2 件選択中');
  });

  it('キャンセルで選択モードを抜け、選択は残らない', () => {
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('home-select-bar')).toBeNull();
    enterSelectMode();
    expect(screen.getByTestId('home-select-bar').textContent).toContain('0 件選択中');
  });

  it('確認ダイアログのキャンセルでは削除 API を呼ばない', () => {
    const fetchSpy = mockDelete();
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'ゴミ箱へ移動' }));
    const dialog = screen.getByTestId('trash-confirm-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('trash-confirm-dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // 選択は保持したまま（やり直せる）
    expect(screen.getByTestId('home-select-bar').textContent).toContain('1 件選択中');
  });

  it('一覧ビューでも同じ選択モードが使える（ボード専用に癒着させない）', () => {
    const { onPick } = renderHome('panel');
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('home-select-bar').textContent).toContain('1 件選択中');
  });
});
