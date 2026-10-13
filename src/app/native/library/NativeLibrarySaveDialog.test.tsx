/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {NativeLibrarySaveDialog} from './NativeLibrarySaveDialog';
afterEach(()=>cleanup());
const setup=(onSave=vi.fn().mockResolvedValue(undefined))=>{const onClose=vi.fn();const v=render(<NativeLibrarySaveDialog assetName="pop" onSave={onSave} onClose={onClose}/>);return {v,onSave,onClose};};
it('defaults the name to the file name and disables save when empty',()=>{
  const {v}=setup();
  const name=v.getByLabelText('名前') as HTMLInputElement;expect(name.value).toBe('pop');
  const save=v.getByRole('button',{name:'保存'}) as HTMLButtonElement;expect(save.disabled).toBe(false);
  fireEvent.change(name,{target:{value:'   '}});expect(save.disabled).toBe(true);
  expect(name.maxLength).toBe(120);expect((v.getByLabelText('説明（任意）') as HTMLTextAreaElement).maxLength).toBe(2000);
});
it('calls onSave with trimmed values and closes',async()=>{
  const {v,onSave,onClose}=setup();
  fireEvent.change(v.getByLabelText('名前'),{target:{value:'  ポン  '}});
  fireEvent.change(v.getByLabelText('説明（任意）'),{target:{value:' 軽い音 '}});
  fireEvent.click(v.getByRole('button',{name:'保存'}));
  await waitFor(()=>expect(onClose).toHaveBeenCalled());
  expect(onSave).toHaveBeenCalledWith('ポン','軽い音');
});
it('shows the server message on failure and stays open',async()=>{
  const {v,onClose}=setup(vi.fn().mockRejectedValue(new Error('ほかの保存が進行中です')));
  fireEvent.click(v.getByRole('button',{name:'保存'}));
  await waitFor(()=>expect(v.getByRole('alert').textContent).toContain('ほかの保存が進行中です'));
  expect(onClose).not.toHaveBeenCalled();
  expect((v.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false);
});
it('does not submit twice while saving',async()=>{
  let release=()=>{};const onSave=vi.fn(()=>new Promise<void>(r=>{release=r;}));
  const {v,onClose}=setup(onSave);
  const save=v.getByRole('button',{name:'保存'}) as HTMLButtonElement;
  fireEvent.click(save);fireEvent.click(save);
  expect(onSave).toHaveBeenCalledTimes(1);expect(save.disabled).toBe(true);
  release();await waitFor(()=>expect(onClose).toHaveBeenCalled());
});
it('closes on Escape',()=>{const {onClose}=setup();fireEvent.keyDown(window,{key:'Escape'});expect(onClose).toHaveBeenCalled();});
