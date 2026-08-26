/**
 * @vitest-environment jsdom
 */
/**
 * カードのバッジメニューからの「リンク化で容量回収」。
 * 破壊的な置換なので、①探す→②見つかった接続先を見せて確認（既定キャンセル）→③実行
 * の順序と、コピー取り込みでないプロジェクトに導線を出さないことを固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from './HomeDashboard';
import { linkCandidateRequest, convertToLinkRequest } from '../convertLinkApi';

vi.mock('../convertLinkApi', () => ({
  linkCandidateRequest: vi.fn(),
  convertToLinkRequest: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

const COPIED: ProjectSummary = {
  id: 'proj-a',
  name: 'proj-a',
  orientation: 'v',
  durationLabel: '1:00',
  sizeLabel: '12.3 GB',
  videoFile: 'main.mp4',
  status: 'telop',
  steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
} as ProjectSummary;

const LINKED: ProjectSummary = {
  ...COPIED,
  id: 'proj-b',
  name: 'proj-b',
  videoLink: { target: '/Volumes/SSD/x.mp4', state: 'ok' },
};

function renderHome(projects: ProjectSummary[]): { onProjectsChanged: ReturnType<typeof vi.fn> } {
  const onProjectsChanged = vi.fn();
  render(
    <HomeDashboard
      projects={projects}
      error={null}
      onPick={vi.fn()}
      onSetStage={vi.fn()}
      onCreate={vi.fn()}
      onProjectsChanged={onProjectsChanged}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
  return { onProjectsChanged };
}

function openMenu(name: string): void {
  const card = screen.getByTitle(name);
  const badge = card.querySelector('.home-card-badge-wrap button');
  fireEvent.click(badge as Element);
}

describe('リンク化で容量回収', () => {
  it('コピー取り込みのカードにだけ導線が出る（容量つき）', () => {
    renderHome([COPIED, LINKED]);
    openMenu('proj-a');
    expect(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' })).toBeTruthy();
    cleanup();

    renderHome([LINKED]);
    openMenu('proj-b');
    expect(screen.queryByRole('menuitem', { name: /リンク化/ })).toBeNull();
  });

  it('見つからなければ理由を出し、確認ダイアログは開かない', async () => {
    vi.mocked(linkCandidateRequest).mockResolvedValue({
      matched: false,
      reason: 'no-candidate',
      message: '同じ動画が見つかりませんでした',
    });
    renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    await waitFor(() => expect(screen.getByText('同じ動画が見つかりませんでした')).toBeTruthy());
    expect(screen.queryByTestId('convert-link-dialog')).toBeNull();
    expect(convertToLinkRequest).not.toHaveBeenCalled();
  });

  it('見つかったら接続先と注意文つきで確認し、キャンセルなら実行しない', async () => {
    vi.mocked(linkCandidateRequest).mockResolvedValue({
      matched: true,
      target: '/Volumes/SSD/take1.mp4',
      sizeBytes: 100,
      mtimeMs: 0,
    });
    renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    const dialog = await screen.findByTestId('convert-link-dialog');
    expect(dialog.textContent).toContain('/Volumes/SSD/take1.mp4');
    expect(dialog.textContent).toContain('SSD を外すと編集できなくなります');
    // 退避ではなく削除（I-1）。「ゴミ箱から戻せる」と読ませない。
    expect(dialog.textContent).toContain('コピーを削除してリンクに置き換えます');
    expect(dialog.textContent).toContain('同一の動画が外付けにあることを確認済みです');
    // リンク化で失われる機能も先に伝える（M-3）。
    expect(dialog.textContent).toContain('音量調整・ノイズ除去が使えなくなります');
    // 既定フォーカスはキャンセル（Enter の連打で破壊的操作が走らない）。
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(convertToLinkRequest).not.toHaveBeenCalled();
  });

  it('確定すると実行し、回収した容量を通知して一覧を取り直す', async () => {
    vi.mocked(linkCandidateRequest).mockResolvedValue({
      matched: true,
      target: '/Volumes/SSD/take1.mp4',
      sizeBytes: 100,
      mtimeMs: 0,
    });
    vi.mocked(convertToLinkRequest).mockResolvedValue({
      target: '/Volumes/SSD/take1.mp4',
      freedBytes: 13_200_000_000,
    });
    const { onProjectsChanged } = renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    await screen.findByTestId('convert-link-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'リンク化する' }));
    await waitFor(() => expect(convertToLinkRequest).toHaveBeenCalledWith('proj-a'));
    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalled());
    expect(screen.getByText(/回収しました/)).toBeTruthy();
    expect(screen.queryByTestId('convert-link-dialog')).toBeNull();
  });

  it('探索中は「反応しません」と断ってから待たせる（I-5）', async () => {
    // 探索はサーバ側で同期に走るので、その間エディタ操作は返らない。黙って固まらせない。
    vi.mocked(linkCandidateRequest).mockReturnValue(new Promise(() => { /* 解決しない */ }));
    renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    openMenu('proj-a');
    await waitFor(() =>
      expect(
        screen.getByRole('menuitem', { name: '探しています…（この間エディタは一時的に反応しません）' }),
      ).toBeTruthy(),
    );
  });

  it('コピーを消せなかった場合は「回収した」と言わずゴミ箱の残りを伝える（I-1）', async () => {
    vi.mocked(linkCandidateRequest).mockResolvedValue({
      matched: true,
      target: '/Volumes/SSD/take1.mp4',
      sizeBytes: 100,
      mtimeMs: 0,
    });
    vi.mocked(convertToLinkRequest).mockResolvedValue({
      target: '/Volumes/SSD/take1.mp4',
      freedBytes: 0,
      keptCopyPath: '.trash/abc/main.mp4',
    });
    renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    await screen.findByTestId('convert-link-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'リンク化する' }));
    await waitFor(() => expect(screen.getByText(/ゴミ箱/)).toBeTruthy());
    expect(screen.queryByText(/を回収しました/)).toBeNull();
  });

  it('実行に失敗したら理由を出したままにする（黙って成功に見せない）', async () => {
    vi.mocked(linkCandidateRequest).mockResolvedValue({
      matched: true,
      target: '/Volumes/SSD/take1.mp4',
      sizeBytes: 100,
      mtimeMs: 0,
    });
    vi.mocked(convertToLinkRequest).mockRejectedValue(new Error('書き出し中です'));
    renderHome([COPIED]);
    openMenu('proj-a');
    fireEvent.click(screen.getByRole('menuitem', { name: 'リンク化して 12.3 GB を回収できるか調べる' }));
    await screen.findByTestId('convert-link-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'リンク化する' }));
    await waitFor(() => expect(screen.getByText('書き出し中です')).toBeTruthy());
  });
});
