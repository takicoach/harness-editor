/** @vitest-environment jsdom */
import {createRef,forwardRef} from 'react';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeScriptPanel,type NativeScriptHandle} from './NativeScriptPanel';
import {createScriptDocument} from '../../core/scriptDocumentData';
import type {NativeSession,NativeCommand} from './api';
vi.mock('./NativePreview',()=>({NativePreview:forwardRef(()=>null)}));
vi.mock('./NativeScriptEditReview',()=>({NativeScriptEditReview:forwardRef(()=>null)}));
vi.mock('./scriptImport',()=>({SCRIPT_FILE_ACCEPT:'.txt',importScriptFile:async(file:File)=>new TextDecoder().decode(await file.arrayBuffer())}));
afterEach(cleanup);
function fixture(){
  const script=(text:string)=>createScriptDocument(text,{documentId:'script',revision:crypto.randomUUID()});
  let current={sessionId:'s1',dirty:false,savedRevision:0,savedContentHash:'',canUndo:false,canRedo:false,document:{schemaVersion:2,id:'p1',name:'案件',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[],transitions:[],transcripts:[],scriptDocument:script('保存本文')}} as NativeSession;
  let deferred=false,releaseSave!:(ok:boolean)=>void;
  const execute=vi.fn(async(command:NativeCommand)=>{
    const session=current.sessionId,ok=deferred?await new Promise<boolean>(r=>{releaseSave=r;}):true;
    if(ok&&session===current.sessionId&&command.type==='set-script'){current={...current,document:{...current.document,revision:current.document.revision+1,scriptDocument:command.script??undefined}};rerender();}
    return ok;
  });
  const onDraft=vi.fn(),ref=createRef<NativeScriptHandle>();
  const props=()=>({projectId:current.document.id,state:current,busy:false,occurrenceId:'',read:()=>current,execute,save:async()=>true,onSourcePreview:()=>{},onDraft});
  const view=render(<NativeScriptPanel ref={ref} {...props()}/>);
  function rerender(){view.rerender(<NativeScriptPanel ref={ref} {...props()}/>);}
  const text=()=>view.getByRole('textbox') as HTMLTextAreaElement;
  let releaseImport!:(b:ArrayBuffer)=>void;
  const readFile=vi.fn(()=>new Promise<ArrayBuffer>(r=>{releaseImport=r;}));
  const upload=()=>fireEvent.change(view.getByLabelText('台本ファイルをアップロード'),{target:{files:[{name:'原稿.txt',size:12,arrayBuffer:readFile}]}});
  return {view,text,ref,onDraft,execute,readFile,upload,edit:(value:string)=>fireEvent.change(text(),{target:{value}}),
    defer:()=>{deferred=true;},save:async(ok:boolean)=>{await act(async()=>{releaseSave(ok);});},
    finish:async()=>{await act(async()=>{releaseImport(new TextEncoder().encode('ファイル本文').buffer);});},
    session:(value='保存本文',project='p1')=>{current={...current,sessionId:crypto.randomUUID(),document:{...current.document,id:project,scriptDocument:script(value)}};rerender();}};
}
it('marks extraction as a draft for autosave, but unchanged manual flush succeeds without a command',async()=>{
  const f=fixture();f.upload();expect(f.onDraft).toHaveBeenLastCalledWith(true);
  let ok;await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);expect(f.execute).not.toHaveBeenCalled();
  f.view.unmount();expect(f.onDraft).toHaveBeenLastCalledWith(false);await f.finish();
});
it('retains a failed draft across a new session and keeps a divergent saved text as a conflict',async()=>{
  const f=fixture();f.edit('残す下書き');f.defer();let task!:Promise<boolean>;act(()=>{task=f.ref.current!.flush();});await f.save(false);expect(await task).toBe(false);
  f.session('別操作の本文');expect(f.text().value).toBe('残す下書き');expect(f.view.getByText('保存済みの台本を読み直す')).toBeTruthy();
  let ok;await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(false);expect(f.execute).toHaveBeenCalledTimes(1);
});
it('keeps a same-project dirty draft applicable when the new session has the same saved text',async()=>{
  const f=fixture();f.edit('再接続しても保持');f.session();expect(f.text().value).toBe('再接続しても保持');
  let ok;await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({script:expect.objectContaining({text:'再接続しても保持'})}));
});
it('does not carry dirty text to a different project',()=>{
  const f=fixture();f.edit('旧案件の下書き');f.session('新案件本文','p2');expect(f.text().value).toBe('新案件本文');
});
it('waits for an already pending blur commit before taking the import revision',async()=>{
  const f=fixture();f.edit('反映する下書き');f.defer();fireEvent.blur(f.text());f.upload();expect(f.readFile).not.toHaveBeenCalled();
  await f.save(true);expect(f.readFile).toHaveBeenCalledTimes(1);await f.finish();expect(f.text().value).toBe('ファイル本文');expect(f.view.queryByRole('alert')).toBeNull();
});
it('rejects a file when the pending blur save failed and keeps the draft',async()=>{
  const f=fixture();f.edit('保持する入力');f.defer();fireEvent.blur(f.text());f.upload();await f.save(false);
  expect(f.readFile).not.toHaveBeenCalled();expect(f.text().value).toBe('保持する入力');expect(f.view.getByRole('alert')).toBeTruthy();
});
it('does not let an old session commit completion clear the conflict in a new session',async()=>{
  const f=fixture();f.edit('旧保存');f.defer();let task!:Promise<boolean>;act(()=>{task=f.ref.current!.flush();});
  f.session('新保存');f.edit('新しい入力');await f.save(true);expect(await task).toBe(false);
  expect(f.text().value).toBe('新しい入力');expect(f.view.getByText('保存済みの台本を読み直す')).toBeTruthy();
});
it('does not report an old project save as successful or change the new clean project',async()=>{
  const f=fixture();f.edit('旧案件保存');f.defer();let task!:Promise<boolean>;act(()=>{task=f.ref.current!.flush();});
  f.session('新案件本文','p2');await f.save(true);expect(await task).toBe(false);
  expect(f.text().value).toBe('新案件本文');expect(f.view.queryByRole('alert')).toBeNull();
  let ok;await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);expect(f.execute).toHaveBeenCalledTimes(1);
});
it('retires a file awaiting a blur commit when its project changes',async()=>{
  const f=fixture();f.edit('旧入力');f.defer();fireEvent.blur(f.text());f.upload();
  f.session('新案件本文','p2');await f.save(true);expect(f.readFile).not.toHaveBeenCalled();
  expect(f.text().value).toBe('新案件本文');expect(f.view.queryByRole('alert')).toBeNull();
});
it('does not rebase a conflicting file import onto a changed server script',async()=>{
  const f=fixture();f.edit('元の下書き');f.session('別操作の本文');f.upload();await f.finish();
  expect(f.text().value).toBe('ファイル本文');let ok;await act(async()=>{ok=await f.ref.current!.flush();});
  expect(ok).toBe(false);expect(f.execute).not.toHaveBeenCalled();
  expect(f.view.getByText('保存済みの台本を読み直す')).toBeTruthy();
});
it('keeps manual changes made while waiting for a blur commit instead of importing over them',async()=>{
  const f=fixture();f.edit('保存要求');f.defer();fireEvent.blur(f.text());f.upload();f.edit('後からの入力');await f.save(true);
  expect(f.readFile).not.toHaveBeenCalled();expect(f.text().value).toBe('後からの入力');expect(f.view.getByRole('alert')).toBeTruthy();
});
it('blocks a changed draft while importing and permits applying it after the import is rejected',async()=>{
  const f=fixture();f.upload();f.edit('取り込み中の入力');let ok;
  await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(false);expect(f.execute).not.toHaveBeenCalled();
  await f.finish();expect(f.text().value).toBe('取り込み中の入力');
  await act(async()=>{ok=await f.ref.current!.flush();});expect(ok).toBe(true);
});
it('clears the imported filename on manual changes and a conflict reload',async()=>{
  const f=fixture();f.upload();await f.finish();expect(f.view.getByText('原稿.txt')).toBeTruthy();f.edit('手編集');expect(f.view.queryByText('原稿.txt')).toBeNull();
  f.upload();await f.finish();f.session('別操作');fireEvent.click(f.view.getByText('保存済みの台本を読み直す'));expect(f.text().value).toBe('別操作');expect(f.view.queryByText('原稿.txt')).toBeNull();
});

it('preserves later text while blur and tab-switch flush await the first save',async()=>{
  const f=fixture();f.edit('反映中の文章');f.defer();fireEvent.blur(f.text());
  f.edit('反映を待つ間に追加した文章');fireEvent.blur(f.text());
  let task!:Promise<boolean>;act(()=>{task=f.ref.current!.flush();});
  await f.save(true);
  expect(f.text().value).toBe('反映を待つ間に追加した文章');
  expect(f.execute).toHaveBeenCalledTimes(2);
  await f.save(true);expect(await task).toBe(true);
});
