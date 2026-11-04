/**
 * ホームへのドロップの振り分け（フォルダ＝作品1つ・ファイル＝1件ずつ作品）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const createNativeProject = vi.fn(async (name: string, _path: string) => ({ id: name }));
vi.mock('../native/api', async (importActual) => ({
  ...(await importActual<typeof import('../native/api')>()),
  createNativeProject: (name: string, path: string) => createNativeProject(name, path),
}));
const { HomeDashboard } = await import('./HomeDashboard');

const file = (name: string): File => new File(['x'], name);
/** ドロップされた1件。フォルダは webkitGetAsEntry().isDirectory が true になる。 */
const entry = (isDirectory: boolean) => ({ webkitGetAsEntry: () => ({ isDirectory }) });

function drop(home: Element, items: ReadonlyArray<{ file: File; folder: boolean }>): void {
  fireEvent.drop(home, {
    dataTransfer: {
      files: items.map((item) => item.file),
      types: ['Files'],
      items: items.map((item) => entry(item.folder)),
    },
  });
}

function renderHome() {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onProjectsChanged = vi.fn();
  const { container } = render(
    <HomeDashboard managedMedia projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()}
      onCreate={onCreate} onProjectsChanged={onProjectsChanged} />,
  );
  return { onCreate, onProjectsChanged, home: container.querySelector('.home')! };
}

const notice = () => document.querySelector('.home-drop-notice')?.textContent ?? null;
const imported: string[] = [];

beforeEach(() => {
  imported.length = 0;
  // デスクトップ版は File から実パスを取れる。ドロップの取り込みはこのパスだけを使う。
  (window as Window & { harnessDesktop?: { getPathForFile(file: File): string } }).harnessDesktop = {
    getPathForFile: (dropped: File) => `/ssd/${dropped.name}`,
  };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { folderPath?: string };
    imported.push(String(body.folderPath));
    return { ok: true, json: async () => ({ id: String(body.folderPath).split('/').pop() }) } as Response;
  }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('フォルダを2つドロップしたらフォルダごとに作品を作る', async () => {
  const { home, onProjectsChanged } = renderHome();
  drop(home, [{ file: file('素材A'), folder: true }, { file: file('素材B'), folder: true }]);
  await waitFor(() => expect(imported).toEqual(['/ssd/素材A', '/ssd/素材B']));
  await waitFor(() => expect(notice()).toContain('フォルダから 2 件作成しました: 素材A、素材B'));
  expect(onProjectsChanged).toHaveBeenCalled();
});

it('動画を複数ドロップしたらファイルの数だけ作品を作り、名前が重ならない', async () => {
  const { home } = renderHome();
  drop(home, [{ file: file('clip2.mp4'), folder: false }, { file: file('clip2.mp4'), folder: false }]);
  await waitFor(() => expect(createNativeProject).toHaveBeenCalledTimes(2));
  const names = createNativeProject.mock.calls.map((call) => call[0]);
  expect(names[0]).toMatch(/-clip2$/);
  expect(names[1]).toBe(`${names[0]} 2`);
  expect(createNativeProject.mock.calls.map((call) => call[1])).toEqual(['/ssd/clip2.mp4', '/ssd/clip2.mp4']);
});

it('画像の複数ドロップは今までどおり1つの作品にまとめる', () => {
  const { home, onCreate } = renderHome();
  drop(home, [{ file: file('img2.png'), folder: false }, { file: file('img1.png'), folder: false }]);
  fireEvent.click(screen.getByRole('button', { name: '作成' }));
  expect(createNativeProject).not.toHaveBeenCalled();
  expect(onCreate.mock.calls[0]![1].files.map((picked: File) => picked.name)).toEqual(['img1.png', 'img2.png']);
});

it('フォルダとファイルが混ざっていたらフォルダを先に作る', async () => {
  const { home } = renderHome();
  drop(home, [
    { file: file('素材A'), folder: true },
    { file: file('a.mp4'), folder: false },
    { file: file('b.mp4'), folder: false },
  ]);
  await waitFor(() => expect(createNativeProject).toHaveBeenCalledTimes(2));
  expect(imported).toEqual(['/ssd/素材A']);
});

it('フォルダに見えて実体がファイルだったら、ファイルの作成として扱い直す', async () => {
  // 拡張子が無いファイルはフォルダと区別できない。サーバの not-a-directory で作成へ戻し、
  // 生の合図ではなく普段どおりの案内を出す。
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'not-a-directory' }) }) as Response));
  const { home } = renderHome();
  drop(home, [{ file: file('拡張子なし動画'), folder: true }]);
  await waitFor(() => expect(notice()).toContain('動画・音声・画像のファイルを選んでください'));
  expect(notice()).not.toContain('not-a-directory');
});
