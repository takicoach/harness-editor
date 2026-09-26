/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowseListing } from '../browseApi';

const listing: BrowseListing = { roots: [{ key: '/ssd', label: 'SSD', path: '/ssd' }], path: '/ssd', parent: null, dirs: [], truncated: false,
  files: [{ name: 'a.png', path: '/ssd/a.png', sizeBytes: 1024 }, { name: 'b.png', path: '/ssd/b.png', sizeBytes: 2048 }] };
vi.mock('../browseApi', () => ({ browseFolder: vi.fn(async () => listing) }));
const { HomeDashboard } = await import('./HomeDashboard');

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function renderHome() {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const { container } = render(<HomeDashboard managedMedia projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate}
    onProjectsChanged={vi.fn()} now={Date.parse('2026-09-26T00:00:00Z')} />);
  return { onCreate, home: container.querySelector('.home')! };
}
const file = (name: string, size = 3) => new File(['x'.repeat(size)], name);
function select(files: File[]): void {
  const input = screen.getByTestId('home-create-file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}
const drop = (home: Element, files: File[]) => fireEvent.drop(home, { dataTransfer: { files, types: ['Files'] } });
const notice = () => document.querySelector('.home-drop-notice')?.textContent ?? null;

describe('ファイル選択（設計 M5・M6b）', () => {
  it('accept は動画・音声・画像、複数選択できる', () => {
    renderHome();
    const input = screen.getByTestId('home-create-file') as HTMLInputElement;
    for (const extension of ['.mp4', '.mp3', '.wav', '.png', '.jpg']) expect(input.accept.split(',')).toContain(extension);
    expect(input.multiple).toBe(true);
  });
  it('音声1件: ダイアログは「素材: 名前」で、今の動画と同じコピーの選択肢を出す', () => {
    const { onCreate } = renderHome();
    select([file('talk.mp3')]);
    expect(screen.getByText('素材: talk.mp3')).toBeTruthy();
    expect(screen.getByTestId('home-create-copy')).toBeTruthy();
    expect(screen.queryByTestId('home-create-images-note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(onCreate).toHaveBeenCalledWith(expect.any(String), { kind: 'upload', file: expect.objectContaining({ name: 'talk.mp3' }) }, false, expect.any(Function));
  });
  it('画像3枚: 選んだ順のまま、コピーすること・枚数・合計を出し、コピーの選択肢は出さない', () => {
    const { onCreate } = renderHome();
    select([file('c.png', 1024), file('a.jpg', 1024), file('b.png', 1024)]);
    expect(screen.getByText('素材: 画像 3 枚（c.png ほか）')).toBeTruthy();
    expect(screen.getByTestId('home-create-images-note').textContent).toContain('画像 3 枚（合計 3 KB）をコピーして取り込みます');
    expect(screen.queryByTestId('home-create-copy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    const source = onCreate.mock.calls[0]![1];
    expect(source.kind).toBe('upload-images');
    expect(source.files.map((f: File) => f.name)).toEqual(['c.png', 'a.jpg', 'b.png']);
  });
  it('201 枚は理由だけ出してダイアログを開かない', () => {
    renderHome();
    select(Array.from({ length: 201 }, (_, index) => file(`${index}.png`)));
    expect(notice()).toContain('200枚');
    expect(document.querySelector('.home-create-dialog')).toBeNull();
  });
});

describe('ドロップ（設計 M1・M3・M6）', () => {
  it('複数の画像はファイル名の並び（数字は数として）で並べる', () => {
    const { home, onCreate } = renderHome();
    drop(home, [file('img10.png'), file('img2.png'), file('img1.png')]);
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(onCreate.mock.calls[0]![1].files.map((f: File) => f.name)).toEqual(['img1.png', 'img2.png', 'img10.png']);
    expect(notice()).toBeNull();
  });
  it('種類が混ざったら作成せず「どれか1種類」と案内する', () => {
    const { home } = renderHome();
    drop(home, [file('talk.mp3'), file('cover.png')]);
    expect(notice()).toBe('動画・音声・画像のどれか1種類を選んでください');
    expect(document.querySelector('.home-create-dialog')).toBeNull();
  });
  it('音声・動画の複数は1件目だけ（通知を出す）', () => {
    const { home } = renderHome();
    drop(home, [file('a.mp3'), file('b.mp3')]);
    expect(notice()).toBe('2 件ドロップされました。1件目のみ取り込みます: a.mp3');
    expect(screen.getByText('素材: a.mp3')).toBeTruthy();
  });
  it('受け付けない拡張子は対応の拡張子を示す', () => {
    const { home } = renderHome();
    drop(home, [file('notes.txt')]);
    expect(notice()).toContain('動画・音声・画像のファイルを選んでください');
  });
});

describe('フォルダから選ぶ（設計 M6b）', () => {
  it('画像を2枚選ぶとコピーの作成になり、選んだ順に渡す', async () => {
    const { onCreate } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'フォルダから選ぶ' }));
    fireEvent.click(await screen.findByRole('button', { name: /b\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: /a\.png/ }));
    fireEvent.click(screen.getByTestId('mp-confirm'));
    expect(screen.getByText('素材: 画像 2 枚（b.png ほか）')).toBeTruthy();
    expect(screen.getByTestId('home-create-images-note').textContent).toContain('合計 3 KB');
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(onCreate.mock.calls[0]![1]).toEqual({ kind: 'link-images', files: [listing.files[1], listing.files[0]] });
  });
});
