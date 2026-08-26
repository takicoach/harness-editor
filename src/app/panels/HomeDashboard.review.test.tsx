/**
 * @vitest-environment jsdom
 */
/**
 * 前バッチ（選択一括除外・ゴミ箱画面・保存先表示）のレビュー指摘の回帰テスト。
 * I-2（失敗分の選択を残す）と Minor 5 件（選択の剪定・送信中の無効化・
 * 通知のクリア・エラー画面のゴミ箱導線・「保存先を開く」の失敗通知）。
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
    dir: `/root/${id}`,
    orientation: 'v',
    durationLabel: '1:00',
    sizeLabel: '1 MB',
    videoFile: null,
    status: 'telop',
    steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
  } as ProjectSummary;
}

const A = project('proj-a');
const B = project('proj-b');

function renderHome(projects: ProjectSummary[] = [A, B], error: string | null = null) {
  saveHomeView('kanban');
  const onProjectsChanged = vi.fn();
  const view = render(
    <HomeDashboard
      projects={projects}
      error={error}
      onPick={vi.fn()}
      onSetStage={vi.fn()}
      onCreate={vi.fn()}
      onProjectsChanged={onProjectsChanged}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
  const rerender = (next: ProjectSummary[]): void => {
    view.rerender(
      <HomeDashboard
        projects={next}
        error={null}
        onPick={vi.fn()}
        onSetStage={vi.fn()}
        onCreate={vi.fn()}
        onProjectsChanged={onProjectsChanged}
        now={Date.parse('2026-08-26T00:00:00Z')}
      />,
    );
  };
  return { onProjectsChanged, rerender };
}

function enterSelectMode(): void {
  fireEvent.click(screen.getByRole('button', { name: '選択' }));
}

function card(name: string): HTMLElement {
  return screen.getByText(name).closest('.home-card') as HTMLElement;
}

/** DELETE /api/project のスパイ（failFor の id だけ 409 busy）。 */
function mockDelete(failFor: string[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const id = new URL(String(input), 'http://localhost').searchParams.get('id') ?? '';
    if (failFor.includes(id)) {
      return new Response(JSON.stringify({ error: 'busy', jobs: ['render'] }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ entry: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function bulkMove(): void {
  fireEvent.click(
    within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'ゴミ箱へ移動' }),
  );
  fireEvent.click(screen.getByTestId('trash-confirm-ok'));
}

describe('I-2 部分失敗のとき失敗分の選択を残す', () => {
  it('1 件成功・1 件 busy なら選択モードのまま、選択は失敗した 1 件だけになる', async () => {
    mockDelete(['proj-b']);
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    fireEvent.click(card('proj-b'));
    bulkMove();

    await screen.findByTestId('home-bulk-notice');
    // 原因（実行中ジョブ）を解消したらそのまま再実行できる状態で止める。
    const bar = screen.getByTestId('home-select-bar');
    expect(bar.textContent).toContain('1 件選択中');
    expect(card('proj-b').classList.contains('selected')).toBe(true);
    expect(card('proj-a').classList.contains('selected')).toBe(false);
  });
});

describe('M-1 一覧から消えた ID を state からも剪定する', () => {
  it('選択中のプロジェクトが一覧から消えたら、戻ってきても選択は復活しない', () => {
    const { rerender } = renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    expect(screen.getByTestId('home-select-bar').textContent).toContain('1 件選択中');

    rerender([B]);
    expect(screen.getByTestId('home-select-bar').textContent).toContain('0 件選択中');

    // 同じ ID が戻ってきても、剪定済みなので選択は付いていない
    // （表示だけ剪定していると、ここで選択が蘇る）。
    rerender([A, B]);
    expect(screen.getByTestId('home-select-bar').textContent).toContain('0 件選択中');
    expect(card('proj-a').classList.contains('selected')).toBe(false);
  });
});

describe('M-2 一括移動の送信中は他の導線も止める', () => {
  it('送信中は「選択」と「ゴミ箱」も押せない', async () => {
    // 応答を返さない fetch で送信中状態に固定する。
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    bulkMove();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '選択' }).hasAttribute('disabled')).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'ゴミ箱' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('M-3 一括移動の通知を持ち越さない', () => {
  it('選択モードを抜けると通知は消える', async () => {
    mockDelete(['proj-a']);
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    bulkMove();
    await screen.findByTestId('home-bulk-notice');

    fireEvent.click(
      within(screen.getByTestId('home-select-bar')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByTestId('home-bulk-notice')).toBeNull();
  });

  it('ゴミ箱ビューを開くと通知は消える', async () => {
    mockDelete(['proj-a']);
    renderHome();
    enterSelectMode();
    fireEvent.click(card('proj-a'));
    bulkMove();
    await screen.findByTestId('home-bulk-notice');

    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱' }));
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.queryByTestId('home-bulk-notice')).toBeNull();
  });
});

describe('M-4 一覧取得に失敗した画面にもゴミ箱導線を出す', () => {
  it('エラー表示でもゴミ箱を開ける（復元の唯一の入口を塞がない）', () => {
    renderHome([], '接続できません');
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱' }));
    expect(screen.getByRole('button', { name: '戻る' })).toBeTruthy();
  });
});

describe('M-5 「保存先を開く」の失敗を画面に出す', () => {
  it('404 のときは理由を表示する（console.warn だけで黙らせない）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'プロジェクトが見つかりません: proj-a' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderHome();
    const badge = card('proj-a').querySelector('.home-card-badge-wrap button');
    fireEvent.click(badge as Element);
    fireEvent.click(screen.getByRole('menuitem', { name: '保存先を開く' }));
    await waitFor(() =>
      expect(screen.getByTestId('home-reveal-error').textContent).toContain(
        'プロジェクトが見つかりません',
      ),
    );
  });
});
