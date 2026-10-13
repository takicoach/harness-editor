// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { thumbnailFixture } from '../../../core/thumbnail/fixtures';
import type { ThumbnailDocument } from '../../../core/thumbnail/model';
import type { ThumbnailEditor } from './useThumbnailEditor';
import type { ThumbnailExportHook } from './useThumbnailExport';
import type { ThumbnailPreviewImages } from './useThumbnailPreviews';
import { ThumbnailPages } from './ThumbnailPages';

afterEach(cleanup);
function view(mainPageId?: string, running = false) {
  const document: ThumbnailDocument = { ...thumbnailFixture(), ...(mainPageId ? { mainPageId } : {}) };
  document.pages.push({ id: 'page-b', name: '案B', hueShift: 0, layers: [] });
  const execute = vi.fn(async () => true), startAll = vi.fn(async () => undefined);
  const editor = { document, pageId: 'page-a', disabled: false, zoom: 'fit', scale: 1, execute, selectPage: vi.fn(), setZoom: vi.fn() } as unknown as ThumbnailEditor;
  const exporter = { running, startAll } as unknown as ThumbnailExportHook;
  render(<ThumbnailPages editor={editor} exporter={exporter} previews={{ url: () => null } as unknown as ThumbnailPreviewImages} phoneOpen={false} onPhone={vi.fn()} />);
  return { execute, startAll };
}

describe('下部の案の帯: メインの案', () => {
  it('既定は先頭の案に「メイン」の印。ほかの案に「メインにする」', () => {
    view();
    const items = screen.getByRole('list', { name: '案' }).querySelectorAll('li');
    expect(items[0]!.querySelector('.native-thumbnail-page-main')!.textContent).toBe('メイン');
    expect(items[0]!.querySelector('button.native-thumbnail-page-set-main')).toBeNull();
    expect(items[1]!.querySelector('.native-thumbnail-page-main')).toBeNull();
    expect(screen.getByRole('button', { name: '案Bをメインにする' })).toBeTruthy();
  });
  it('「メインにする」で set-main-page を送る。印はメインの案に付く', () => {
    const { execute } = view('page-b');
    expect(screen.getByRole('list', { name: '案' }).querySelectorAll('li')[1]!.querySelector('.native-thumbnail-page-main')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '案Aをメインにする' }));
    expect(execute).toHaveBeenCalledWith({ type: 'set-main-page', pageId: 'page-a' });
  });
  it('「すべての案を書き出す」でまとめて書き出す。書き出し中は押せない', () => {
    const { startAll } = view();
    fireEvent.click(screen.getByRole('button', { name: 'すべての案を書き出す' }));
    expect(startAll).toHaveBeenCalledTimes(1);
    cleanup();
    view(undefined, true);
    expect((screen.getByRole('button', { name: 'すべての案を書き出す' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
