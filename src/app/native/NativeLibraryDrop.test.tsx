/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeLibraryDrop} from './NativeLibraryDrop';
afterEach(cleanup);
const protectedFiles=(count:number)=>({types:['Files'],items:Array.from({length:count},()=>({kind:'file'})),files:[],dropEffect:'none'});
it('counts protected OS drag items before files are readable and stays visible over children',()=>{
 const view=render(<NativeLibraryDrop disabled={false} onFiles={vi.fn()}><button>素材</button></NativeLibraryDrop>);
 const zone=view.getByLabelText('プロジェクトと素材'),dataTransfer=protectedFiles(2);
 fireEvent.dragEnter(zone,{dataTransfer});expect(view.getByRole('status').textContent).toContain('2件の素材を追加');
 fireEvent.dragEnter(view.getByRole('button'),{dataTransfer});fireEvent.dragLeave(zone,{dataTransfer});
 expect(view.getByRole('status').textContent).toContain('2件の素材を追加');expect(dataTransfer.dropEffect).toBe('copy');
 fireEvent.dragLeave(view.getByRole('button'),{dataTransfer});expect(view.queryByRole('status')).toBeNull();
});
it('imports the whole batch once and reports actual completion, not just the drop',async()=>{
 let finish!:(n:number)=>void;const onFiles=vi.fn(()=>new Promise<number>(resolve=>{finish=resolve;}));
 const view=render(<NativeLibraryDrop disabled={false} onFiles={onFiles}>素材</NativeLibraryDrop>),zone=view.getByLabelText('プロジェクトと素材');
 const files=[new File(['a'],'a.mp4'),new File(['b'],'b.mp4')];
 fireEvent.drop(zone,{dataTransfer:{files}});fireEvent.drop(zone,{dataTransfer:{files}});
 expect(onFiles).toHaveBeenCalledOnce();expect(onFiles).toHaveBeenCalledWith(files);
 expect(view.getByRole('status').textContent).toContain('2件の素材を取り込み中');
 await act(async()=>finish(2));expect(view.getByRole('status').textContent).toContain('2件の素材を追加しました');
});
it('does not announce full success for a partial batch',async()=>{
 const view=render(<NativeLibraryDrop disabled={false} onFiles={async()=>1}>素材</NativeLibraryDrop>);
 fireEvent.drop(view.getByLabelText('プロジェクトと素材'),{dataTransfer:{files:[new File(['a'],'a.mp4'),new File(['b'],'b.mp4')]}});
 await waitFor(()=>expect(view.getByRole('status').textContent).toContain('1 / 2件を追加しました'));
});
it('blocks imports while busy and ignores existing asset drags',()=>{
 const onFiles=vi.fn(),view=render(<NativeLibraryDrop disabled onFiles={onFiles}>素材</NativeLibraryDrop>),zone=view.getByLabelText('プロジェクトと素材');
 fireEvent.dragEnter(zone,{dataTransfer:{types:['application/x-harness-asset'],items:[],files:[]}});expect(view.queryByRole('status')).toBeNull();
 const dataTransfer=protectedFiles(2);fireEvent.dragEnter(zone,{dataTransfer});expect(dataTransfer.dropEffect).toBe('none');
 fireEvent.drop(zone,{dataTransfer:{files:[new File(['a'],'a.mp4')]}});expect(onFiles).not.toHaveBeenCalled();
});
it.each(['dragend','blur','escape'])('clears the affordance after %s',event=>{
 const view=render(<NativeLibraryDrop disabled={false} onFiles={vi.fn()}>素材</NativeLibraryDrop>);
 fireEvent.dragEnter(view.getByLabelText('プロジェクトと素材'),{dataTransfer:protectedFiles(2)});
 if(event==='escape')fireEvent.keyDown(window,{key:'Escape'});else fireEvent(window,new Event(event));
 expect(view.queryByRole('status')).toBeNull();
});
