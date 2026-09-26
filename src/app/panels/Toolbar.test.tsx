/**
 * @vitest-environment jsdom
 */
/**
 * ⚠ メニュー内の「部品の更新」まわりの表示回帰（Task 10）。
 *
 * ・更新の前に「何が変わるか」が出る（件数が数えられない案件では、0 件ではなく「数えられません」）。
 * ・「更新前に戻す」は控えがある時だけ出て、更新が成功して stale が空になっても**消えない**
 *   （事前検査 B の B10-2。バッジ自体が消えると入口ごと失われるので、そこも合わせて見る）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Toolbar } from './Toolbar';
import type { PackUpgradeNotice } from '../usePackStatus';

afterEach(cleanup);

const notice = (gainingCount: number | null): PackUpgradeNotice => ({
  id: 'telopPack',
  note: 'このパックは描画が変わります（テロップに動きが付きます）。',
  gainingCount,
});

function toolbar(extra: Record<string, unknown>) {
  return render(createElement(Toolbar, {
    projectName: 'テスト案件',
    canUndo: false, canRedo: false, dirty: false, saving: false, active: true,
    onUndo: () => {}, onRedo: () => {}, onSave: () => {},
    theme: 'dark' as const, onToggleTheme: () => {},
    layout: 'balanced' as never, onLayoutChange: () => {},
    ducking: { enabled: false, targetDb: -12, attackMs: 100, releaseMs: 300 } as never,
    onDuckingChange: () => {},
    renderState: { status: 'idle' as const },
    onRenderStart: () => {}, onRenderCancel: () => {}, onRenderReveal: () => {}, onRenderDismiss: () => {},
    warnings: [] as string[],
    ...extra,
  } as never));
}

/** ⚠ バッジを押してメニューを開く。 */
function openMenu(view: ReturnType<typeof toolbar>) {
  fireEvent.click(view.getByTestId('toolbar-warn-badge'));
}

describe('Toolbar — 部品の更新の事前説明', () => {
  it('件数が数えられない案件では「数えられません」と出す（0 件と読める報告にしない）', () => {
    const view = toolbar({ stalePacks: ['telopPack'], onPackUpgrade: async () => true, packNotices: [notice(null)] });
    openMenu(view);
    expect(view.getByText(/描画が変わります/).textContent).toContain('この案件では数えられません');
  });

  it('数えられる案件では新しく動き始める件数を出す', () => {
    const view = toolbar({ stalePacks: ['telopPack'], onPackUpgrade: async () => true, packNotices: [notice(7)] });
    openMenu(view);
    expect(view.getByText(/描画が変わります/).textContent).toContain('7件の字幕で動き始めます');
  });
});

describe('Toolbar — 更新前に戻す', () => {
  it('控えが無いときは「更新前に戻す」を出さない（更新前に出ない）', () => {
    const view = toolbar({
      stalePacks: ['telopPack'], onPackUpgrade: async () => true,
      packNotices: [notice(null)], packRevertable: false, onPackRevert: async () => true,
    });
    openMenu(view);
    expect(view.queryByRole('button', { name: '更新前に戻す' })).toBeNull();
  });

  it('更新が成功して stale が空になっても「更新前に戻す」は残る', () => {
    const view = toolbar({ stalePacks: [], warnings: [], packRevertable: true, onPackRevert: async () => true });
    // 警告 0・stale 0 でもバッジ（＝メニューの入口）が残ることまで見る。
    openMenu(view);
    expect(view.getByRole('button', { name: '更新前に戻す' })).toBeTruthy();
  });

  it('押す前に「後から足した自分のファイルは残る」と出す（戻す範囲の事前説明）', () => {
    // 復元が消すのは**更新が持ち込んだファイル**だけ。利用者が更新の後に足したものには触れない
    // （Task 10 レビュー C1。実態と違う「消えます」とは書かない）。
    const view = toolbar({ stalePacks: [], packRevertable: true, onPackRevert: async () => true });
    openMenu(view);
    expect(view.getByText(/更新の後に足した自分のファイルは残ります/)).toBeTruthy();
  });

  it('未保存の変更があるときは戻せない（更新と同じ dirty ガード）', () => {
    const view = toolbar({ stalePacks: [], dirty: true, packRevertable: true, onPackRevert: async () => true });
    openMenu(view);
    expect(view.getByRole('button', { name: '更新前に戻す' }).hasAttribute('disabled')).toBe(true);
  });

  it('成功したら後始末（状態の取り直し）を 1 回だけ呼ぶ', async () => {
    const revert = vi.fn(async () => true);
    const done = vi.fn();
    const view = toolbar({ stalePacks: [], packRevertable: true, onPackRevert: revert, onPackUpgraded: done });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '更新前に戻す' })); });
    expect(revert).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('失敗したら後始末を呼ばない', async () => {
    const done = vi.fn();
    const view = toolbar({ stalePacks: [], packRevertable: true, onPackRevert: async () => false, onPackUpgraded: done });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '更新前に戻す' })); });
    expect(done).not.toHaveBeenCalled();
  });
});
