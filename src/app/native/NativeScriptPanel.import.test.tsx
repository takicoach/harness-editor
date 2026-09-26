/** @vitest-environment jsdom */
import {createRef,forwardRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeScriptPanel,type NativeScriptHandle} from './NativeScriptPanel';
import type {NativeSession,NativeCommand} from './api';
vi.mock('./NativePreview',()=>({NativePreview:forwardRef(()=>null)}));
vi.mock('./NativeScriptEditReview',()=>({NativeScriptEditReview:forwardRef(()=>null)}));
vi.mock('./scriptImport',()=>({SCRIPT_FILE_ACCEPT:'.docx,.pdf,.txt,.md,.srt',importScriptFile:async(file:File)=>new TextDecoder().decode(await file.arrayBuffer())}));
afterEach(cleanup);
function fixture(){
  let current={sessionId:'s-a',dirty:false,savedRevision:0,savedContentHash:'',canUndo:false,canRedo:false,document:{schemaVersion:2,id:'a',name:'台本案件',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[],transitions:[],transcripts:[]}} as NativeSession;
  const execute=vi.fn(async(command:NativeCommand)=>{if(command.type==='set-script')current={...current,document:{...current.document,scriptDocument:command.script??undefined,revision:current.document.revision+1}};return true;}),ref=createRef<NativeScriptHandle>();
  const props=()=>({projectId:current.document.id,state:current,busy:false,occurrenceId:'',read:()=>current,execute,save:async()=>true,onSourcePreview:()=>{},onDraft:()=>{}});
  const view=render(<NativeScriptPanel ref={ref} {...props()}/>);
  let release!:(b:ArrayBuffer)=>void;
  const file={name:'台本.txt',size:20,arrayBuffer:()=>new Promise<ArrayBuffer>(r=>{release=r;})} as File;
  const upload=()=>fireEvent.change(view.getByLabelText(/台本.*ファイル/),{target:{files:[file]}});
  return {view,upload,execute,ref,finish:async()=>{await act(async()=>{release(new TextEncoder().encode('読み込んだ日本語').buffer);});},switchProject:()=>{current={...current,sessionId:'s-b',document:{...current.document,id:'b'}};view.rerender(<NativeScriptPanel ref={ref} {...props()}/>);}};
}
it('does not replace an edited draft even when the text is restored before extraction resolves',async()=>{
  const f=fixture();f.upload();const text=f.view.getByRole('textbox');
  fireEvent.change(text,{target:{value:'途中の入力'}});fireEvent.change(text,{target:{value:''}});
  await f.finish();expect((text as HTMLTextAreaElement).value).toBe('');expect(f.execute).not.toHaveBeenCalled();
});
it('retires an in-flight import on a project/session change even when revisions match',async()=>{
  const f=fixture();f.upload();f.switchProject();await f.finish();
  expect((f.view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');expect(f.view.queryByRole('alert')).toBeNull();expect(f.execute).not.toHaveBeenCalled();
});
it('shows indeterminate reading progress and stages extracted text for explicit confirmation',async()=>{
  const f=fixture();f.upload();expect(f.view.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  await f.finish();await waitFor(()=>expect((f.view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('読み込んだ日本語'));
  expect(f.view.queryByRole('progressbar')).toBeNull();expect(f.execute).not.toHaveBeenCalled();
});
it('allows an unchanged draft to flush while extraction is pending',async()=>{
  const f=fixture();f.upload();let ok:boolean|undefined;
  await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);expect(f.execute).not.toHaveBeenCalled();await f.finish();
});
it('drops an old import completion after unmount without reporting a late error',async()=>{
  const f=fixture();f.upload();f.view.unmount();await f.finish();expect(f.execute).not.toHaveBeenCalled();
});

it('passes the staged file through the existing explicit flush/set-script contract',async()=>{
  const f=fixture();f.upload();await f.finish();let ok:boolean|undefined;
  await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);
  expect(f.execute).toHaveBeenCalledTimes(1);expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({type:'set-script',script:expect.objectContaining({text:'読み込んだ日本語'})}));
});
