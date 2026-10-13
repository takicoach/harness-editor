/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
vi.mock('../browseApi',()=>({browseFolder:vi.fn(async(path?:string)=>({roots:[{key:'ssd',label:'ssd',path:'/Volumes/SSD'}],path:path??null,parent:path?'/Volumes/SSD':null,
  dirs:path?[]:[{name:'mine',path:'/Volumes/SSD/mine'}],files:path?[{name:'clip.mp4',path:'/Volumes/SSD/mine/clip.mp4',sizeBytes:1}]:[],truncated:false}))}));
import {MediaPicker} from './MediaPicker';
afterEach(cleanup);
it('offers choosing the shown folder only inside a folder',async()=>{
  const onPickFolder=vi.fn();render(<MediaPicker title="コピー先のフォルダーを選ぶ" onPick={vi.fn()} onPickFolder={onPickFolder} folderLabel="このフォルダーにコピー" onCancel={vi.fn()}/>);
  const button=await screen.findByRole('button',{name:'このフォルダーにコピー'});expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByText('mine'));await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);expect(onPickFolder).toHaveBeenCalledWith('/Volumes/SSD/mine');
});
// フォルダーを選ぶ時は、ファイルは中身の目安として見せるだけ（押しても何も選ばない）。
it('shows files without picking them while choosing a folder',async()=>{
  const onPick=vi.fn();render(<MediaPicker title="コピー先のフォルダーを選ぶ" onPick={onPick} onPickFolder={vi.fn()} onCancel={vi.fn()}/>);
  fireEvent.click(await screen.findByText('mine'));const file=(await screen.findByText('clip.mp4')).closest('button')!;
  expect(file.disabled).toBe(true);fireEvent.click(file);expect(onPick).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'このフォルダーを選ぶ'})).toBeTruthy();
});
it('does not say there are no videos in an empty folder while choosing a folder',async()=>{
  const {browseFolder}=await import('../browseApi');
  vi.mocked(browseFolder).mockResolvedValueOnce({roots:[{key:'ssd',label:'ssd',path:'/Volumes/SSD'}],path:'/Volumes/SSD/empty',parent:'/Volumes/SSD',dirs:[],files:[],truncated:false});
  render(<MediaPicker title="コピー先のフォルダーを選ぶ" onPick={vi.fn()} onPickFolder={vi.fn()} onCancel={vi.fn()}/>);
  expect(await screen.findByText('この中にフォルダーはありません。このフォルダーを選べます')).toBeTruthy();expect(screen.queryByText(/動画はありません|素材はありません/)).toBeNull();
});
