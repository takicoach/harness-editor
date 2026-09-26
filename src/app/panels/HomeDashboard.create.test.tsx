/**
 * @vitest-environment jsdom
 */
/**
 * 作成モーダルの「コピーして取り込む」導線のテスト。
 *
 * 既定ではサーバが登録済みフォルダから同一実体を探してリンク化する（内蔵を消費しない）。
 * ユーザーが明示的にコピーを選べる逃げ道を 1 つ残すのが要件なので、
 * チェックの有無が onCreate の preferCopy へそのまま渡ることを固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from './HomeDashboard';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const PROJECTS: ProjectSummary[] = [];

function renderHome(managedMedia=false): { onCreate: ReturnType<typeof vi.fn> } {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <HomeDashboard
      managedMedia={managedMedia}
      projects={PROJECTS}
      error={null}
      onPick={vi.fn()}
      onSetStage={vi.fn()}
      onCreate={onCreate}
      onProjectsChanged={vi.fn()}
      now={Date.parse('2026-08-26T00:00:00Z')}
    />,
  );
  return { onCreate };
}

/** hidden file input へ動画を渡して作成モーダルを開く。 */
function openModal(): void {
  const input = screen.getByTestId('home-create-file') as HTMLInputElement;
  const file = new File(['x'], 'take1.mp4', { type: 'video/mp4' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('作成モーダルのコピー指定', () => {
  it.each([false,true])('native creation preserves the explicit copy choice %s',copy=>{
    const {onCreate}=renderHome(true);openModal();
    expect((screen.getByTestId('home-create-copy') as HTMLInputElement).checked).toBe(false);
    if(copy)fireEvent.click(screen.getByTestId('home-create-copy'));
    fireEvent.click(screen.getByRole('button',{name:'作成'}));
    expect(onCreate).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({kind:'upload'}),copy,expect.any(Function));
  });
  it('既定はリンク優先（preferCopy=false）で、説明文が出る', () => {
    const { onCreate } = renderHome();
    openModal();
    expect(screen.getByTestId('home-create-copy')).toBeTruthy();
    expect((screen.getByTestId('home-create-copy') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(onCreate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'upload' }), false);
  });

  it('チェックすると preferCopy=true で作成する', () => {
    const { onCreate } = renderHome();
    openModal();
    fireEvent.click(screen.getByTestId('home-create-copy'));
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(onCreate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'upload' }), true);
  });
});
