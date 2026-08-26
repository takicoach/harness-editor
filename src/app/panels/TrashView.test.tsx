/**
 * @vitest-environment jsdom
 */
/**
 * ゴミ箱ビュー（ルート＝プロジェクトのゴミ箱）の結線テスト。
 * 実機フィードバック: 小さなダイアログではなく、進行ボードと同じ一覧画面で見たい。
 * API は既存の GET /api/trash・restore・empty をそのまま使う（サーバは変更しない）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TrashView } from './TrashView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ENTRIES = [
  {
    id: 'e1',
    kind: 'project',
    name: 'proj-a',
    originalPath: 'proj-a',
    deletedAt: '2026-08-25T01:02:03.000Z',
  },
  {
    id: 'e2',
    kind: 'project',
    name: 'proj-b',
    originalPath: 'proj-b',
    deletedAt: '2026-08-25T02:02:03.000Z',
  },
];

/** /api/trash 系のモック。呼ばれた (url, body) を記録する。 */
function mockTrashApi(opts: { entries?: unknown[]; listFails?: boolean } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let entries = opts.entries ?? ENTRIES;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, body });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/api/trash/restore')) {
      const id = (body as { entryId: string }).entryId;
      entries = entries.filter((e) => (e as { id: string }).id !== id);
      return json({ restoredPath: 'proj-a' });
    }
    if (url.startsWith('/api/trash/empty')) {
      const b = body as { entryId?: string; all?: boolean };
      const before = entries.length;
      entries = b.all === true ? [] : entries.filter((e) => (e as { id: string }).id !== b.entryId);
      return json({ removed: before - entries.length });
    }
    if (url.startsWith('/api/trash')) {
      if (opts.listFails === true) return json({ error: 'こわれています' }, 500);
      return json({ entries });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { calls, spy };
}

function renderView() {
  const onBack = vi.fn();
  const onChanged = vi.fn();
  render(<TrashView onBack={onBack} onChanged={onChanged} />);
  return { onBack, onChanged };
}

describe('ゴミ箱ビュー', () => {
  it('カード型の一覧で名前・削除日時・元の保存先を出す', async () => {
    mockTrashApi();
    renderView();
    await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
    const card = screen.getAllByTestId('trash-card')[0] as HTMLElement;
    expect(card.classList.contains('home-card')).toBe(true);
    expect(within(card).getByText('proj-a')).toBeTruthy();
    expect(card.textContent).toContain('削除');
    // 元の保存先（TrashEntry.originalPath）
    expect(card.textContent).toContain('proj-a');
  });

  it('ルート（プロジェクトのゴミ箱）を読む＝id を付けない', async () => {
    const { calls } = mockTrashApi();
    renderView();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toBe('/api/trash');
  });

  it('空なら「ゴミ箱は空です」と出し、「空にする」は出さない', async () => {
    mockTrashApi({ entries: [] });
    renderView();
    expect(await screen.findByText('ゴミ箱は空です')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ゴミ箱を空にする' })).toBeNull();
  });

  it('復元でカードが消え、一覧の再取得を親へ通知する', async () => {
    const { calls } = mockTrashApi();
    const { onChanged } = renderView();
    await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
    const card = screen.getByText('proj-a').closest('.home-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '復元' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.url === '/api/trash/restore' && (c.body as { entryId: string }).entryId === 'e1')).toBe(true);
    await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(1));
  });

  it('完全削除は確認（既定フォーカスはキャンセル）を経てから飛ぶ', async () => {
    const { calls } = mockTrashApi();
    renderView();
    await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
    const card = screen.getByText('proj-b').closest('.home-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '完全削除' }));
    const dialog = screen.getByTestId('trash-confirm-dialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBe(document.activeElement);
    // キャンセルでは飛ばない
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(calls.some((c) => c.url === '/api/trash/empty')).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: '完全削除' }));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/trash/empty' && (c.body as { entryId?: string }).entryId === 'e2')).toBe(true),
    );
  });

  it('「ゴミ箱を空にする」は all:true で全件消す', async () => {
    const { calls } = mockTrashApi();
    renderView();
    await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱を空にする' }));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/trash/empty' && (c.body as { all?: boolean }).all === true)).toBe(true),
    );
    await waitFor(() => expect(screen.getByText('ゴミ箱は空です')).toBeTruthy());
  });

  it('「戻る」で呼び出し元へ帰る', async () => {
    mockTrashApi();
    const { onBack } = renderView();
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(onBack).toHaveBeenCalled();
  });

  /**
   * サムネイル（実機フィードバック「ゴミ箱にもサムネイルを出してほしい」）。
   * ホームカードと同じ機構（VideoThumb・`.home-card-thumb`）を使い、
   * 配信だけを tombstone 用の GET /api/trash/video へ向ける。
   */
  describe('サムネイル', () => {
    it('プロジェクトのカードはホームと同じサムネ枠に tombstone の動画を出す', async () => {
      mockTrashApi();
      renderView();
      await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
      const card = screen.getByText('proj-a').closest('.home-card') as HTMLElement;
      const thumb = card.querySelector('.home-card-thumb');
      expect(thumb).toBeTruthy();
      const video = thumb?.querySelector('video');
      // パスではなく entryId だけを送る（サーバが manifest から実体を導出する）。
      expect(video?.getAttribute('src')).toBe('/api/trash/video?entryId=e1');
    });

    it('動画を読めない tombstone はプレースホルダへ落ちる（カードは壊れない）', async () => {
      const { calls } = mockTrashApi();
      const { onChanged } = renderView();
      await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(2));
      const card = screen.getByText('proj-a').closest('.home-card') as HTMLElement;
      const video = card.querySelector('video') as HTMLVideoElement;
      fireEvent.error(video);
      expect(card.querySelector('video')).toBeNull();
      expect(card.querySelector('.home-card-thumb-empty')).toBeTruthy();
      // サムネは補助。失敗をエラー表示に昇格させない（一覧が赤くならない）。
      expect(screen.queryByRole('alert')).toBeNull();
      // 復元は**実際に押して**従来どおり飛ぶ（ボタンの存在確認で終わらせない）。
      fireEvent.click(within(card).getByRole('button', { name: '復元' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(
        calls.some((c) => c.url === '/api/trash/restore' && (c.body as { entryId: string }).entryId === 'e1'),
      ).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('プロジェクト以外（素材）の項目は配信を叩かずプレースホルダにする', async () => {
      mockTrashApi({
        entries: [
          { id: 'e9', kind: 'se', name: 'beep.mp3', originalPath: 'public/se/beep.mp3', deletedAt: '2026-08-25T01:02:03.000Z' },
        ],
      });
      renderView();
      await waitFor(() => expect(screen.getAllByTestId('trash-card')).toHaveLength(1));
      const card = screen.getAllByTestId('trash-card')[0] as HTMLElement;
      expect(card.querySelector('video')).toBeNull();
      expect(card.querySelector('.home-card-thumb-empty')).toBeTruthy();
    });
  });

  it('読み込みに失敗したら理由を表示する', async () => {
    mockTrashApi({ listFails: true });
    renderView();
    expect(await screen.findByText('こわれています')).toBeTruthy();
  });
});
