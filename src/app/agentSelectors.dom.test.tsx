/**
 * @vitest-environment jsdom
 *
 * AI エージェント（コンピュータユース）向けの安定セレクタを、**実 DOM で**確かめる。
 *
 * `agentSelectors.test.ts` はソースを文字列 grep しているだけなので、
 *   - 条件分岐の中に閉じ込められて実際には描かれない
 *   - コメントアウトされたコードに書いてある
 * ような場合を通してしまう（サイクル 3 の残 Minor）。ここでは実際にマウントして
 * `document.querySelector` で拾えることを確かめる。grep 版は「ソースにこの文字列が
 * ある」という別の保証なので残す（描画条件が複雑な要素はそちらが受け持つ）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Toolbar } from './panels/Toolbar';
import { DEFAULT_DUCKING } from './edit/duckingSettings';

vi.mock('./panels/TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

afterEach(cleanup);

function renderToolbar(): HTMLElement {
  const { container } = render(
    <Toolbar
      projectName="2026-09-04-C0123"
      canUndo
      canRedo
      dirty
      saving={false}
      active
      onUndo={() => {}}
      onRedo={() => {}}
      onSave={() => {}}
      theme="dark"
      onToggleTheme={() => {}}
      layout="standard"
      onLayoutChange={() => {}}
      ducking={DEFAULT_DUCKING}
      onDuckingChange={() => {}}
      renderState={{ status: 'idle' }}
      onRenderStart={() => {}}
      onRenderCancel={() => {}}
      onRenderReveal={() => {}}
      onRenderDismiss={() => {}}
      warnings={['テスト警告']}
    />,
  );
  return container;
}

describe('ツールバーの安定セレクタ（実 DOM）', () => {
  it('保存・書き出し・undo・redo・警告バッジが実際に描かれている', () => {
    const c = renderToolbar();
    for (const id of [
      'toolbar-save',
      'toolbar-export',
      'toolbar-undo',
      'toolbar-redo',
      'toolbar-warn-badge',
    ]) {
      expect(c.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
  });

  it('保存ボタンは押せる要素（button）として出ている', () => {
    const save = renderToolbar().querySelector('[data-testid="toolbar-save"]');
    expect(save?.tagName).toBe('BUTTON');
  });
});
