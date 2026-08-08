/**
 * @vitest-environment jsdom
 *
 * reveal エラー文の文字切れ回帰。
 * 「フォルダで表示」の失敗文言を `.tb-render-label`（nowrap + text-overflow:ellipsis）に
 * 載せると、進捗バーで直したのと同じ「途中で切れて読めない」が完了トーストで再発する。
 * 省略しない専用クラス（.tb-render-note）に載っていることを固定する。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Toolbar } from './Toolbar';

afterEach(() => {
  cleanup();
});

const LONG_ERROR = '書き出しファイルが見つかりません（out フォルダに動画がありません）。';

function renderToolbar(revealError: string | null) {
  return render(
    <Toolbar
      projectName="p"
      canUndo={false}
      canRedo={false}
      dirty={false}
      saving={false}
      active
      onUndo={() => {}}
      onRedo={() => {}}
      onSave={() => {}}
      theme="dark"
      onToggleTheme={() => {}}
      layout="standard"
      onLayoutChange={() => {}}
      ducking={{ enabled: true, strength: 'mid' }}
      onDuckingChange={() => {}}
      renderState={{ status: 'done' }}
      onRenderStart={() => {}}
      onRenderCancel={() => {}}
      onRenderReveal={() => {}}
      renderRevealError={revealError}
      onRenderDismiss={() => {}}
      warnings={[]}
      stalePacks={[]}
      onPackUpgrade={async () => true}
      onPackUpgraded={() => {}}
      onShowTutorial={() => {}}
    />,
  );
}

describe('reveal エラー文の表示', () => {
  it('省略クラス（.tb-render-label）には載せない', () => {
    renderToolbar(LONG_ERROR);
    const el = screen.getByText(LONG_ERROR);
    expect(el.classList.contains('tb-render-label')).toBe(false);
  });

  it('折り返す専用クラス（.tb-render-note）で全文が入る', () => {
    renderToolbar(LONG_ERROR);
    const el = screen.getByText(LONG_ERROR);
    expect(el.classList.contains('tb-render-note')).toBe(true);
    expect(el.textContent).toBe(LONG_ERROR);
  });

  it('エラーが無ければ何も出さない（完了トーストを汚さない）', () => {
    renderToolbar(null);
    expect(document.querySelector('.tb-render-note')).toBeNull();
  });
});
