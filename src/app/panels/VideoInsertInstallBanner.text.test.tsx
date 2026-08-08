/**
 * @vitest-environment jsdom
 *
 * バナー文言の回帰。未導入プロジェクトでもプレビューには映る（FALLBACK_INSERT_VIDEO）
 * ようになったため、警告は「プレビューには出ている / 書き出しには入らない」の
 * 両方を言い切る必要がある。片方だけに戻ると、たきコーチ報告と同じ
 * 「映っているのに警告が出る＝どっちが本当か分からない」状態へ逆戻りする。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { VideoInsertInstallBanner } from './VideoInsertInstallBanner';

afterEach(() => {
  cleanup();
});

function renderBanner() {
  return render(
    <VideoInsertInstallBanner
      installing={false}
      busy={false}
      dirty={false}
      error={null}
      onInstall={() => {}}
    />,
  );
}

describe('VideoInsertInstallBanner の文言', () => {
  it('プレビューには映るが書き出しには入らないことを両方明示する', () => {
    renderBanner();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('プレビュー');
    expect(text).toContain('書き出し');
  });

  it('「プレビューにも表示されません」という旧前提の言い回しを含まない', () => {
    renderBanner();
    const text = (screen.getByRole('status').textContent ?? '').replace(/\s+/g, '');
    expect(text).not.toContain('プレビューにも');
  });

  it('導入ボタンは残る（警告としての役割を失っていない）', () => {
    renderBanner();
    expect(screen.getByRole('button', { name: 'サブ動画機能を導入' })).toBeTruthy();
  });
});
