/**
 * @vitest-environment jsdom
 */
/**
 * ホームのカードに出る「保存先」表示と Finder で開く導線のテスト。
 * 実機フィードバック: どのフォルダに保存されているか分からない。
 * パスは表示だけに使い、開く操作は id を送る（サーバが id からパスを導出する）。
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

const BASE = {
  name: 'proj-a',
  orientation: 'v',
  durationLabel: '1:00',
  sizeLabel: '1 MB',
  videoFile: null,
  status: 'telop',
  steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
} as const;

function renderHome(p: Partial<ProjectSummary>) {
  saveHomeView('panel');
  render(
    <HomeDashboard
      projects={[{ ...BASE, id: 'proj-a', ...p } as ProjectSummary]}
      error={null}
      onPick={vi.fn()}
      onSetStage={vi.fn()}
      onCreate={vi.fn()}
      onProjectsChanged={vi.fn()}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
}

describe('カードの保存先表示', () => {
  it('保存先の絶対パスをラベル付きで出す（全文は tooltip）', () => {
    renderHome({ dir: '/Users/x/VideoEditing/projects/proj-a' });
    const row = screen.getByTestId('home-card-path');
    expect(row.textContent).toContain('保存先');
    expect(row.textContent).toContain('/Users/x/VideoEditing/projects/proj-a');
    expect(row.getAttribute('title')).toBe('/Users/x/VideoEditing/projects/proj-a');
  });

  it('dir を知らない旧サーバの応答では保存先行を出さない', () => {
    renderHome({});
    expect(screen.queryByTestId('home-card-path')).toBeNull();
  });

  it('リンク取り込みなら動画の実体パスも出す', () => {
    renderHome({
      dir: '/Users/x/projects/proj-a',
      videoLink: { target: '/Volumes/SSD/raw/clip.mp4', state: 'ok' },
    });
    const row = screen.getByTestId('home-card-link');
    expect(row.textContent).toContain('動画の実体');
    expect(row.textContent).toContain('/Volumes/SSD/raw/clip.mp4');
    expect(row.classList.contains('warn')).toBe(false);
  });

  it('リンク切れ（broken）は警告表示にして未接続と伝える', () => {
    renderHome({
      dir: '/Users/x/projects/proj-a',
      videoLink: { target: '/Volumes/SSD/raw/clip.mp4', state: 'broken' },
    });
    const row = screen.getByTestId('home-card-link');
    expect(row.classList.contains('warn')).toBe(true);
    expect(row.textContent).toContain('未接続');
  });

  it('別の動画に差し替わっている（mismatch）ときも警告する', () => {
    renderHome({
      dir: '/Users/x/projects/proj-a',
      videoLink: { target: '/Volumes/SSD/raw/clip.mp4', state: 'mismatch' },
    });
    const row = screen.getByTestId('home-card-link');
    expect(row.classList.contains('warn')).toBe(true);
    expect(row.textContent).toContain('別の動画');
  });

  it('メニューの「保存先を開く」は id を送る（生パスを送らない）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    renderHome({ dir: '/Users/x/projects/proj-a' });
    const card = screen.getByTestId('home-card-path').closest('.home-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('menuitem', { name: '保存先を開く' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/project/reveal?id=proj-a');
    expect(init.method).toBe('POST');
    expect(String(init.body ?? '')).not.toContain('/Users/x');
  });
});
