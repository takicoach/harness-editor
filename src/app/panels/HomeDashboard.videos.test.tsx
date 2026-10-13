/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {HomeDashboard} from './HomeDashboard';
afterEach(()=>{cleanup();localStorage.clear();});
const select=(files:File[])=>{const input=screen.getByTestId('home-create-file') as HTMLInputElement;Object.defineProperty(input,'files',{value:files,configurable:true});fireEvent.change(input);};
const home=(managedMedia:boolean)=>{const onCreate=vi.fn().mockResolvedValue(undefined);
  render(<HomeDashboard managedMedia={managedMedia} projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate} onProjectsChanged={vi.fn()}/>);return onCreate;};
it('creates one project with several videos in natural name order',async()=>{
  const onCreate=home(true);select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  expect(screen.getByText('素材: 動画 2 本（clip2.mp4 ほか）')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(onCreate).toHaveBeenCalled());
  const source=onCreate.mock.calls[0]![1] as {kind:string;files:File[]};expect(source.kind).toBe('videos');expect(source.files.map(f=>f.name)).toEqual(['clip2.mp4','clip10.mp4']);
});
it('keeps the legacy screen to the first video only',()=>{
  home(false);select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  expect(screen.getByRole('status').textContent).toContain('1件目のみ取り込みます');
});

// ---- Task 8: 上限・コピーの選択 ----
it('refuses more videos than one batch takes, before creating anything',()=>{
  const onCreate=home(true);select(Array.from({length:51},(_,index)=>new File(['x'],`clip${index}.mp4`)));
  expect(screen.getByRole('status').textContent).toBe('動画は1回に50本まで作成できます（選んだ動画: 51 本）');
  expect(screen.queryByRole('button',{name:'作成'})).toBeNull();expect(onCreate).not.toHaveBeenCalled();
});
it('offers to copy several videos and passes the choice on',async()=>{
  const onCreate=home(true);select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  fireEvent.click(screen.getByTestId('home-create-copy'));fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(onCreate).toHaveBeenCalled());expect((onCreate.mock.calls[0]![1] as {kind:string}).kind).toBe('videos');expect(onCreate.mock.calls[0]![2]).toBe(true);
});
