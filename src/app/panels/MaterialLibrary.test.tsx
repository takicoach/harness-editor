/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MaterialLibrary } from './MaterialLibrary';

afterEach(cleanup);
const base = {
  kind: 'image' as const, onPickKind: vi.fn(), projectId: 'owned-test',
  seLibrary: [], imageLibrary: [], bgmLibrary: [], videoLibrary: [],
  playingPath: null, onAudition: vi.fn(), onInsert: vi.fn(),
};

describe('素材のファイル選択', () => {
  it('空の素材欄から複数ファイルを既存の取り込み処理へ渡し、キャンセルでは取り込まない', () => {
    const onDropFiles = vi.fn();
    render(<MaterialLibrary {...base} onDropFiles={onDropFiles} />);
    const input = screen.getByLabelText('取り込む素材ファイル') as HTMLInputElement;
    const open = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: '素材を読み込む' }));
    expect(open).toHaveBeenCalledOnce();
    expect(input.multiple).toBe(true);
    const files = [new File(['image'], 'sample.png'), new File(['audio'], 'sample.wav')];
    fireEvent.change(input, { target: { files } });
    expect(onDropFiles).toHaveBeenCalledExactlyOnceWith(files);
    fireEvent.change(input, { target: { files: [] } });
    expect(onDropFiles).toHaveBeenCalledTimes(1);
  });

  it('取り込みが許可されない表示ではファイル選択を出さない', () => {
    render(<MaterialLibrary {...base} />);
    expect(screen.queryByRole('button', { name: '素材を読み込む' })).toBeNull();
    expect(screen.queryByLabelText('取り込む素材ファイル')).toBeNull();
  });
});
