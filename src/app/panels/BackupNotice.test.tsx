/**
 * @vitest-environment jsdom
 *
 * 退避先の案内が消えない（サイクル 2 レビュー Important）。
 *
 * 上書き保存で消した相手の内容がどこに退避されたかは、これまで 4 秒で消える
 * トーストにしか出ていなかった。3 行の日本語を読み切る前に消えると、
 * 非エンジニアの利用者は隠しフォルダ `.sme/backup/` を自力で探すしかない。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { BackupNotice } from './BackupNotice';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DIR = '.sme/backup/2026-09-06T16-12-25-843Z';

describe('BackupNotice', () => {
  it('退避先の場所を画面に出す', () => {
    render(<BackupNotice backupDir={DIR} onOpenFolder={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(DIR)).toBeTruthy();
  });

  it('時間が経っても消えない（読み切る前に消えない）', () => {
    vi.useFakeTimers();
    render(<BackupNotice backupDir={DIR} onOpenFolder={() => {}} onDismiss={() => {}} />);
    vi.advanceTimersByTime(60_000);
    expect(screen.getByText(DIR)).toBeTruthy();
  });

  it('案件フォルダを開く導線がある', () => {
    const onOpenFolder = vi.fn();
    render(<BackupNotice backupDir={DIR} onOpenFolder={onOpenFolder} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '案件フォルダを開く' }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('読み終えたら利用者の操作で閉じられる', () => {
    const onDismiss = vi.fn();
    render(<BackupNotice backupDir={DIR} onOpenFolder={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('成功の知らせなので危険色の枠にしない（role も alert にしない）', () => {
    const { container } = render(
      <BackupNotice backupDir={DIR} onOpenFolder={() => {}} onDismiss={() => {}} />,
    );
    const root = container.firstElementChild;
    expect(root?.getAttribute('role')).not.toBe('alert');
    expect(root?.className).toContain('backup-notice');
    expect(root?.className).not.toContain('conflict');
  });
});
