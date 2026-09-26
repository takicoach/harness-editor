// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialEditState } from '../../edit/editState';
import { addImage } from '../../edit/imageOps';
import { ImageSettingsTab } from './ImageSettingsTab';

afterEach(cleanup);
function setup(supported = true, dirty = false) {
  const state = addImage(initialEditState({ mainSpeed: 1, segmentSpeeds: {} }), 'overlay.png', 0);
  const image = state.images[0]!;
  const onEdit = vi.fn(), onInstall = vi.fn();
  render(<ImageSettingsTab image={image} state={state} fps={30} imageLibrary={['overlay.png']}
    renderingSupport={{ supported, canUpgrade: !supported }} dirty={dirty} onInstall={onInstall} onEdit={onEdit} />);
  return { onEdit, onInstall };
}

describe('image controls reflect actual rendering support', () => {
  it('offers the supported update before allowing plain mode or entrance animation', () => {
    const { onInstall } = setup(false);
    expect((screen.getByRole('option', { name: '静止画像（そのまま配置）' }) as HTMLOptionElement).disabled).toBe(true);
    expect(document.querySelector('#ins-image-enter')!.matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '画像表示を更新' }));
    expect(onInstall).toHaveBeenCalledWith('imageRendering');
  });
  it('does not reload an unsaved image edit to perform the update', () => {
    const { onInstall } = setup(false, true);
    const button = screen.getByRole('button', { name: '画像表示を更新' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); expect(onInstall).not.toHaveBeenCalled();
  });
  it('commits an exact scale and negative position only when their drafts finish', () => {
    const { onEdit } = setup();
    const scale = screen.getByLabelText('大きさ（%）');
    fireEvent.change(scale, { target: { value: '12.5' } });
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.blur(scale);
    expect(onEdit.mock.calls[0]![0].images[0].scale).toBe(.125);
    const y = screen.getByLabelText('縦位置（%）');
    fireEvent.change(y, { target: { value: '-59.722222' } }); fireEvent.blur(y);
    expect(onEdit.mock.calls[1]![0].images[0].position.y).toBeCloseTo(-.59722222, 9);
  });
  it('cancels a numeric draft with Escape and does not turn an empty value into zero', () => {
    const { onEdit } = setup(); const x = screen.getByLabelText('横位置（%）') as HTMLInputElement;
    x.focus(); fireEvent.change(x, { target: { value: '81.25' } }); fireEvent.keyDown(x, { key: 'Escape' });
    expect(x.value).toBe('0'); expect(onEdit).not.toHaveBeenCalled();
    fireEvent.change(x, { target: { value: '' } }); fireEvent.blur(x);
    expect(x.value).toBe('0'); expect(onEdit).not.toHaveBeenCalled();
  });
  it('selects plain without changing placement or duration', () => {
    const { onEdit } = setup();
    fireEvent.change(screen.getByLabelText('画像の表示方法'), { target: { value: 'plain' } });
    expect(onEdit.mock.calls[0]![0].images[0]).toEqual({ id: 1, file: 'overlay.png', type: 'plain', originalStart: 0, originalEnd: 120 });
  });
});
