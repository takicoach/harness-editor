/** @vitest-environment jsdom */
import {forwardRef} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeScriptPanel} from './NativeScriptPanel';
import {fetchProjectDocumentFile,fetchProjectDocuments,type NativeCommand,type NativeSession} from './api';
vi.mock('./NativePreview',()=>({NativePreview:forwardRef(()=>null)}));
vi.mock('./NativeScriptEditReview',()=>({NativeScriptEditReview:forwardRef(()=>null)}));
vi.mock('./api',async importOriginal=>({...await importOriginal<typeof import('./api')>(),fetchProjectDocuments:vi.fn(),fetchProjectDocumentFile:vi.fn()}));
vi.mock('./scriptImport',async importOriginal=>({...await importOriginal<typeof import('./scriptImport')>(),importScriptFile:async(file:File)=>new TextDecoder().decode(await new Promise<ArrayBuffer>(ok=>{const reader=new FileReader();reader.onload=()=>ok(reader.result as ArrayBuffer);reader.readAsArrayBuffer(file);}))}));
const doc=(path:string,sizeBytes=10)=>({path,sizeBytes,absolutePath:`/p/資料/${path}`});
function panel(projectId='a'){
  const state={sessionId:'s',dirty:false,savedRevision:0,savedContentHash:'',canUndo:false,canRedo:false,document:{schemaVersion:2,id:projectId,name:'案件',revision:0,fps:{num:30,den:1},resolution:{width:1920,height:1080},assets:[],clips:[],tracks:[]}} as unknown as NativeSession;
  const props={projectId,state,busy:false,occurrenceId:'',read:()=>state,execute:vi.fn(async(_c:NativeCommand)=>true),save:async()=>true,onSourcePreview:()=>{},onDraft:()=>{}};
  return {view:render(<NativeScriptPanel {...props}/>),props};
}
beforeEach(()=>{vi.mocked(fetchProjectDocuments).mockReset();vi.mocked(fetchProjectDocumentFile).mockReset();});
afterEach(cleanup);
it('shows nothing when the project keeps no documents',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([]);panel();
  await waitFor(()=>expect(fetchProjectDocuments).toHaveBeenCalledWith('a'));
  expect(screen.queryByRole('region',{name:'資料'})).toBeNull();
});
it('lists the kept documents with their sub-folders, and reads the chosen one into the script as a draft',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([doc('構成.md'),doc('台本/第1回.txt')]);
  vi.mocked(fetchProjectDocumentFile).mockResolvedValue(new File(['読み込んだ本文'],'第1回.txt'));
  const {props}=panel();
  const buttons=await screen.findAllByRole('button',{name:/台本に読み込む/});
  expect(screen.getByText('台本/第1回.txt')).toBeTruthy();
  fireEvent.click(buttons[1]!);
  await waitFor(()=>expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('読み込んだ本文'));
  expect(fetchProjectDocumentFile).toHaveBeenCalledWith('a','台本/第1回.txt');
  // 読み込むだけで確定はしない（ファイル選択と同じ）。
  expect(props.execute).not.toHaveBeenCalled();
});
it('does not offer a document over the script limit, and says it is only kept',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([doc('大きい.pdf',8_000_001),doc('ぴったり.pdf',8_000_000)]);panel();
  const buttons=await screen.findAllByRole<HTMLButtonElement>('button',{name:/台本に読み込む/});
  expect(buttons.map(button=>button.disabled)).toEqual([true,false]);
  expect(screen.getByText('大きすぎるため読み込めません（保管のみ）')).toBeTruthy();
});
it('says why when the document cannot be read',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([doc('a.txt')]);
  vi.mocked(fetchProjectDocumentFile).mockRejectedValue(new Error('書類が見つかりません: a.txt'));panel();
  fireEvent.click(await screen.findByRole('button',{name:/台本に読み込む/}));
  expect((await screen.findByRole('alert')).textContent).toContain('書類が見つかりません: a.txt');
});
it('keeps the script panel working when the list cannot be read',async()=>{
  vi.mocked(fetchProjectDocuments).mockRejectedValue(new Error('切断'));panel();
  await waitFor(()=>expect(fetchProjectDocuments).toHaveBeenCalled());
  expect(screen.getByLabelText(/台本.*ファイル/)).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});
it('reads the list again for the next project and drops the old one',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValueOnce([doc('a.txt')]).mockResolvedValueOnce([]);
  const {view,props}=panel();await screen.findByText('a.txt');
  view.rerender(<NativeScriptPanel {...props} projectId="b"/>);
  await waitFor(()=>expect(screen.queryByText('a.txt')).toBeNull());
});
const deferred=()=>{let resolve!:(file:File)=>void;const promise=new Promise<File>(ok=>{resolve=ok;});return {promise,resolve};};
it('does not overwrite what was typed while the document was being fetched',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([doc('a.txt')]);
  const wait=deferred();vi.mocked(fetchProjectDocumentFile).mockReturnValue(wait.promise);panel();
  fireEvent.click(await screen.findByRole('button',{name:/台本に読み込む/}));
  await waitFor(()=>expect(fetchProjectDocumentFile).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'手で入れた本文'}});
  wait.resolve(new File(['古い本文'],'a.txt'));
  expect((await screen.findByRole('alert')).textContent).toContain('編集内容が変わりました');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('手で入れた本文');
});
it('lets the newer document win when an earlier one arrives late',async()=>{
  vi.mocked(fetchProjectDocuments).mockResolvedValue([doc('a.txt'),doc('b.txt')]);
  const first=deferred(),second=deferred();
  vi.mocked(fetchProjectDocumentFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);panel();
  const [a,b]=await screen.findAllByRole('button',{name:/台本に読み込む/});
  fireEvent.click(a!);await waitFor(()=>expect(fetchProjectDocumentFile).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(b!.hasAttribute('disabled')).toBe(false));
  fireEvent.click(b!);await waitFor(()=>expect(fetchProjectDocumentFile).toHaveBeenCalledTimes(2));
  second.resolve(new File(['新しい本文'],'b.txt'));
  await waitFor(()=>expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新しい本文'));
  first.resolve(new File(['古い本文'],'a.txt'));
  await new Promise(done=>setTimeout(done,20));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新しい本文');
});

