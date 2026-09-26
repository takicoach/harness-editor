/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowseListing } from '../browseApi';

const listing: BrowseListing = { roots: [{ key: '/ssd', label: 'SSD', path: '/ssd' }], path: '/ssd', parent: null, dirs: [], truncated: false,
  files: [{ name: 'a.png', path: '/ssd/a.png', sizeBytes: 10 }, { name: 'b.jpg', path: '/ssd/b.jpg', sizeBytes: 20 }, { name: 'talk.mp3', path: '/ssd/talk.mp3', sizeBytes: 30 }] };
vi.mock('../browseApi', () => ({ browseFolder: vi.fn(async () => listing) }));
const { MediaPicker } = await import('./MediaPicker');
afterEach(() => { cleanup(); });

function open(multiple: boolean) {
  const onPick = vi.fn(), onPickMany = vi.fn();
  render(<MediaPicker title="素材を選ぶ" media="all" multiple={multiple} onPick={onPick} onPickMany={onPickMany} onCancel={vi.fn()} />);
  return { onPick, onPickMany };
}

describe('フォルダから選ぶ: 画像の複数選択（設計 M6b）', () => {
  it('画像は押した順に選び、「選んだ画像で作成（N 枚）」でその順のまま渡す', async () => {
    const { onPick, onPickMany } = open(true);
    fireEvent.click(await screen.findByRole('button', { name: /b\.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: /a\.png/ }));
    expect(screen.getByRole('button', { name: /b\.jpg/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('1 番目').closest('button')!.textContent).toContain('b.jpg');
    fireEvent.click(screen.getByTestId('mp-confirm'));
    expect(screen.getByTestId('mp-confirm').textContent).toBe('選んだ画像で作成（2 枚）');
    expect(onPickMany).toHaveBeenCalledWith([listing.files[1], listing.files[0]]);
    expect(onPick).not.toHaveBeenCalled();
  });
  it('もう一度押すと選択を外す。1枚だけなら従来の1件として渡す', async () => {
    const { onPick, onPickMany } = open(true);
    fireEvent.click(await screen.findByRole('button', { name: /a\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: /b\.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: /b\.jpg/ }));
    expect(screen.getByRole('button', { name: /b\.jpg/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('mp-confirm'));
    expect(onPick).toHaveBeenCalledWith(listing.files[0]); expect(onPickMany).not.toHaveBeenCalled();
  });
  it('音声・動画の行は押した1件をすぐ選ぶ', async () => {
    const { onPick } = open(true);
    fireEvent.click(await screen.findByRole('button', { name: /talk\.mp3/ }));
    expect(onPick).toHaveBeenCalledWith(listing.files[2]);
  });
  it('multiple でなければ画像も押した1件をすぐ選ぶ（再接続・素材の参照は従来どおり）', async () => {
    const { onPick } = open(false);
    fireEvent.click(await screen.findByRole('button', { name: /a\.png/ }));
    expect(onPick).toHaveBeenCalledWith(listing.files[0]);
    expect(screen.queryByTestId('mp-confirm')).toBeNull();
  });
});
