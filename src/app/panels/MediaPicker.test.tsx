/**
 * @vitest-environment jsdom
 */
/**
 * MediaPicker（リンク取り込みの簡易ファイラ）の「どの応答が新しいか」を検査する（J-0 差し戻し）。
 *
 * 実測した症状: フルスイート e2e の `tests/create-project.spec.ts:122`
 * 「フォルダから選んだ動画をコピーせずリンクで取り込む」が、起点をクリックしたあと
 * `.mp-file external-source-N.mp4` を 60s 待って落ちる（5 ラン中 1 回）。落ちたときの
 * 画面はエラーでも「読み込み中…」でもなく、**起点一覧に戻った静かな空リスト**になる。
 *
 * 根本原因: `load()` が「後から着地した応答ほど新しい」という**到着順の仮定**で
 * setListing していた。本体は React.StrictMode 下（src/app/main.tsx）で走るため、
 * マウント時の effect は 2 回実行され、起点一覧の GET が**2 本同時に飛ぶ**。
 * フルスイートの CPU 飽和で 2 本目が遅れると、
 *
 *   mount 1 本目着地（起点が出る） → 起点クリック → フォルダ一覧が着地（動画が出る）
 *   → mount 2 本目が遅れて着地 → **起点一覧で上書き＝動画が消える**
 *
 * となる。`listing.path === null` かつ `roots.length > 0` は「読み込み中」でも
 * 「このフォルダに動画はありません」でも「選べる場所がありません」でもないため、
 * 画面には何のメッセージも出ず、次のイベントも来ないので永久に固まる。
 *
 * これは J-0 本体（一覧更新とライブ差分の順序）と同じ「順序を推測で決めている」欠陥。
 * 判定を事実（発行順の世代番号）へ寄せる。
 *
 * このテストは実際の interleaving を注入するので、修正前は**毎回**落ちる。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, act as reactAct } from '@testing-library/react';
import type { BrowseListing } from '../browseApi';

const browseFolder = vi.fn<(path?: string) => Promise<BrowseListing>>();
vi.mock('../browseApi', () => ({ browseFolder: (path?: string) => browseFolder(path) }));

const { MediaPicker } = await import('./MediaPicker');

/** act を await 込みで使う薄い包み（着地した promise のマイクロタスクまで流す）。 */
async function act(fn: () => void): Promise<void> {
  await reactAct(async () => { fn(); });
}

const ROOT = { key: '/root', label: '.browse-root', path: '/root' };

function rootsListing(): BrowseListing {
  return { roots: [ROOT], path: null, parent: null, dirs: [], files: [], truncated: false };
}
function folderListing(): BrowseListing {
  return {
    roots: [ROOT],
    path: '/root',
    parent: null,
    dirs: [],
    files: [{ name: 'external-source-2.mp4', path: '/root/external-source-2.mp4', sizeBytes: 1234 }],
    truncated: false,
  };
}

/** 応答を手で着地させるための保留 promise を積む。 */
function pendingBrowse(): Array<(v: BrowseListing) => void> {
  const resolvers: Array<(v: BrowseListing) => void> = [];
  browseFolder.mockImplementation(
    () => new Promise<BrowseListing>((resolve) => { resolvers.push(resolve); }),
  );
  return resolvers;
}

afterEach(() => {
  cleanup();
  browseFolder.mockReset();
});

describe('MediaPicker — どの応答が新しいかを到着順で決めない（J-0）', () => {
  it('マウント時の起点取得が遅れて着地しても、後から選んだフォルダの一覧を巻き戻さない', async () => {
    const pending = pendingBrowse();
    render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(MediaPicker, {
          title: 'リンクで取り込む',
          onPick: () => {},
          onCancel: () => {},
        }),
      ),
    );

    // StrictMode の二重マウントで起点一覧の GET が 2 本飛ぶ（＝実運用と同じ形）。
    await waitFor(() => expect(pending.length).toBe(2));
    const [stale, fresh] = pending;

    // 片方が着地 → 起点ボタンが出る（もう片方はまだ飛んだまま）。
    await act(() => { fresh?.(rootsListing()); });
    const root = await screen.findByRole('button', { name: '.browse-root' });

    // 起点をクリック → フォルダ一覧の GET（3 本目）。
    await act(() => { root.click(); });
    await waitFor(() => expect(pending.length).toBe(3));
    await act(() => { pending[2]?.(folderListing()); });
    expect(document.querySelectorAll('.mp-file').length).toBe(1);

    // 取り残されていたマウント時の GET がここで着地する。起点一覧へ巻き戻してはいけない。
    await act(() => { stale?.(rootsListing()); });

    // 存在検査を並設する: 「崩れていない」の前に「動画の行が実在するか」。
    const files = Array.from(document.querySelectorAll('.mp-file .mp-name')).map((el) => el.textContent);
    expect(files, '遅れて着地した古い起点一覧が、選んだフォルダの一覧を巻き戻している').toEqual([
      'external-source-2.mp4',
    ]);
    // 「読み込み中…」のまま固まってもいない。
    expect(document.querySelector('.mp-empty')).toBeNull();
  });

  it('フォルダ移動の応答同士が入れ替わって着地しても、後で選んだ方が勝つ', async () => {
    const pending = pendingBrowse();
    render(
      React.createElement(MediaPicker, {
        title: 'リンクで取り込む',
        onPick: () => {},
        onCancel: () => {},
      }),
    );
    await waitFor(() => expect(pending.length).toBe(1));
    await act(() => { pending[0]?.(rootsListing()); });

    const root = await screen.findByRole('button', { name: '.browse-root' });
    // 同じ起点を 2 回叩く（連打・再描画で普通に起きる）。
    await act(() => { root.click(); });
    await waitFor(() => expect(pending.length).toBe(2));
    await act(() => { root.click(); });
    await waitFor(() => expect(pending.length).toBe(3));

    // 後から発行した方（3 本目）が先に着地し、古い方（2 本目）が後から着地する。
    await act(() => { pending[2]?.(folderListing()); });
    await act(() => { pending[1]?.(rootsListing()); });

    const files = Array.from(document.querySelectorAll('.mp-file .mp-name')).map((el) => el.textContent);
    expect(files, '後から着地した古い応答が新しい応答を巻き戻している').toEqual([
      'external-source-2.mp4',
    ]);
  });

  it('古い応答のエラーは、新しい応答が出した一覧を消さない', async () => {
    const resolvers: Array<{ resolve: (v: BrowseListing) => void; reject: (e: Error) => void }> = [];
    browseFolder.mockImplementation(
      () => new Promise<BrowseListing>((resolve, reject) => { resolvers.push({ resolve, reject }); }),
    );
    render(
      React.createElement(MediaPicker, {
        title: 'リンクで取り込む',
        onPick: () => {},
        onCancel: () => {},
      }),
    );
    await waitFor(() => expect(resolvers.length).toBe(1));
    await act(() => { resolvers[0]?.resolve(rootsListing()); });

    const root = await screen.findByRole('button', { name: '.browse-root' });
    await act(() => { root.click(); });
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(() => { root.click(); });
    await waitFor(() => expect(resolvers.length).toBe(3));

    await act(() => { resolvers[2]?.resolve(folderListing()); });
    // 古い方が後からエラーで着地する。
    await act(() => { resolvers[1]?.reject(new Error('フォルダを開けませんでした')); });

    expect(document.querySelector('.mp-error'), '古い応答のエラーが新しい一覧を消している').toBeNull();
    expect(document.querySelectorAll('.mp-file').length).toBe(1);
  });
});
