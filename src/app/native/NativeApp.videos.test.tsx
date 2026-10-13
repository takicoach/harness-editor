/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeHome} from './NativeApp';
import {importSeconds} from './importSeconds';
const api=vi.hoisted(()=>({empty:vi.fn(),create:vi.fn(),upload:vi.fn(),reference:vi.fn(),abandon:vi.fn(),cancel:vi.fn(),durations:vi.fn(),saved:vi.fn(),remove:vi.fn(),resolve:vi.fn()}));
vi.mock('../panels/HomeDashboard',async importOriginal=>{const actual=await importOriginal<typeof import('../panels/HomeDashboard')>();return {...actual,HomeDashboardWithAgentBoard:actual.HomeDashboard};});
vi.mock('./api',async importOriginal=>({...(await importOriginal<typeof import('./api')>()),createNativeEmptyProject:(...a:unknown[])=>api.empty(...a),createImportBatch:(...a:unknown[])=>api.create(...a),
  uploadImportItem:(...a:unknown[])=>api.upload(...a),referenceImportItem:(...a:unknown[])=>api.reference(...a),
  abandonImportItems:(...a:unknown[])=>api.abandon(...a),cancelImportBatch:(...a:unknown[])=>api.cancel(...a),savedNativeDocument:(...a:unknown[])=>api.saved(...a)}));
vi.mock('../trashApi',async importOriginal=>({...(await importOriginal<typeof import('../trashApi')>()),deleteProjectRequest:(...a:unknown[])=>api.remove(...a)}));
vi.mock('./videoDuration',()=>({readVideoDurations:(...a:unknown[])=>api.durations(...a)}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:(...a:unknown[])=>api.resolve(...a),picker:null,cancel:()=>{}})}));
vi.mock('./NativeWorkspace',()=>({NativeWorkspace:()=>null}));
vi.mock('../useProjectsWatch',()=>({useProjectsWatch:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
beforeEach(()=>{
  localStorage.clear();sessionStorage.clear();Reflect.deleteProperty(window,'harnessDesktop');
  api.empty.mockReset().mockResolvedValue({id:'new-videos'});api.abandon.mockReset().mockResolvedValue({});api.cancel.mockReset().mockResolvedValue({});api.durations.mockReset().mockResolvedValue(new Map());api.saved.mockReset().mockResolvedValue(null);api.remove.mockReset().mockResolvedValue({});api.upload.mockReset().mockResolvedValue({});api.reference.mockReset().mockResolvedValue({});
  api.resolve.mockReset().mockImplementation(async(file:File)=>({path:`/ssd/${file.name}`,expectedFingerprint:'f'.repeat(64)}));
  // 本物の作成の応答と同じ形（importBatches.create）: 実パス付きの項目も含め、全項目が waiting で返る（サーバの準備は応答の後に非同期で始まる）。
  api.create.mockReset().mockImplementation(async(_id:string,body:{mode:string;items:Array<{key:string;name:string;path?:string}>})=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'new-videos',createdAt:'x',origin:{kind:'home'},placement:'append-main',mode:body.mode,phase:'preparing',
    items:body.items.map((item,index)=>({itemId:`i${index}`,key:item.key,name:item.name,phase:'waiting'}))}));
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>(String(url).startsWith('/api/config')?{tutorialEnabled:false}:{projects:[]})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();Reflect.deleteProperty(window,'harnessDesktop');});
const choose=(files:File[])=>{const input=screen.getByTestId('home-create-file') as HTMLInputElement;Object.defineProperty(input,'files',{value:files,configurable:true});fireEvent.change(input);};
it('desktop: creates an empty project and a home batch of real paths, then opens it',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/m/${file.name}`}});
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.create).toHaveBeenCalledWith('new-videos',expect.objectContaining({origin:'home',mode:'link',items:[{key:'0',name:'clip2.mp4',path:'/Volumes/m/clip2.mp4'},{key:'1',name:'clip10.mp4',path:'/Volumes/m/clip10.mp4'}]}));
  expect(api.upload).not.toHaveBeenCalled();expect(api.reference).not.toHaveBeenCalled();
});
it('desktop link: opens the project without handing the videos over again (the server already took them with their paths)',async()=>{
  // 不具合の再現: 受け付け済みの項目を画面がもう一度渡そうとすると、サーバは 409（受け付け済み）で断る。
  api.reference.mockRejectedValue(Object.assign(new Error('この素材は受け付け済みです'),{status:409,code:'IMPORT_DELIVERED'}));api.saved.mockResolvedValue({clips:[],assets:[],revision:0});
  desktopPaths();const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.create).toHaveBeenCalledWith('new-videos',expect.objectContaining({mode:'link',items:[{key:'0',name:'clip1.mp4',path:'/Volumes/m/clip1.mp4'},{key:'1',name:'clip2.mp4',path:'/Volumes/m/clip2.mp4'}]}));
  expect(api.resolve).not.toHaveBeenCalled();expect(api.reference).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled();
  expect(api.cancel).not.toHaveBeenCalled();expect(api.abandon).not.toHaveBeenCalled();expect(api.remove).not.toHaveBeenCalled();
  expect(screen.queryByText('この素材は受け付け済みです')).toBeNull();
});
it('browser: delivers each waiting item as a verified link before opening',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip2.mp4'),new File(['b'],'clip10.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.reference.mock.calls.map(call=>call[1])).toEqual([{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',itemId:'i0',path:'/ssd/clip2.mp4',expectedFingerprint:'f'.repeat(64)},{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',itemId:'i1',path:'/ssd/clip10.mp4',expectedFingerprint:'f'.repeat(64)}]);
});

// ---- Task 8: 長さの先読み・コピー・受け渡しの失敗 ----
const desktopPaths=()=>Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/m/${file.name}`}});
it('desktop: reads the lengths alongside the batch, not before it, and leaves what it has read for the project it opens, even across a page reload',async()=>{
  desktopPaths();let report!:(key:string,seconds:number)=>void;
  api.durations.mockImplementation((_files:File[],options:{onRead(key:string,seconds:number):void})=>{report=options.onRead;report('0',2);return new Promise(()=>{});});
  // 遷移の時点の sessionStorage を写す（全画面の遷移ではページの状態が消え、sessionStorage だけが残る）。
  const left=new Map<string,string>(),navigate=vi.fn(()=>{for(let index=0;index<sessionStorage.length;index++){const key=sessionStorage.key(index)!;left.set(key,sessionStorage.getItem(key)!);}});
  render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect((api.durations.mock.calls[0]![0] as File[]).map(file=>file.name)).toEqual(['clip2.mp4','clip10.mp4']);
  report('1',3);expect(importSeconds('imp-aaaaaaaaaaaaaaaaaaaa','1')).toBe(3);
  sessionStorage.clear();for(const [key,value] of left)sessionStorage.setItem(key,value);
  vi.resetModules();const fresh=await import('./importSeconds');expect(fresh.importSeconds('imp-aaaaaaaaaaaaaaaaaaaa','0')).toBeUndefined();
  fresh.takeOverImportSeconds('new-videos');expect(fresh.importSeconds('imp-aaaaaaaaaaaaaaaaaaaa','0')).toBe(2);
});
it('desktop copy: sends each video from the screen without real paths (the server does not copy from the path)',async()=>{
  desktopPaths();const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);fireEvent.click(screen.getByTestId('home-create-copy'));fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.create).toHaveBeenCalledWith('new-videos',expect.objectContaining({origin:'home',mode:'copy',items:[{key:'0',name:'clip2.mp4'},{key:'1',name:'clip10.mp4'}]}));
  expect(api.upload.mock.calls.map(call=>[call[1],call[2],(call[3] as File).name])).toEqual([['imp-aaaaaaaaaaaaaaaaaaaa','i0','clip2.mp4'],['imp-aaaaaaaaaaaaaaaaaaaa','i1','clip10.mp4']]);
  expect(api.reference).not.toHaveBeenCalled();
});
it('browser: stops at the first video it cannot deliver, marks the rest failed, and opens the project with the delivered ones',async()=>{
  api.reference.mockImplementation(async(_id:string,body:{itemId:string})=>{if(body.itemId==='i1')throw new Error('保存場所を確認できませんでした');return {};});
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4'),new File(['c'],'clip3.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.create).toHaveBeenCalledWith('new-videos',expect.objectContaining({mode:'link',items:[{key:'0',name:'clip1.mp4'},{key:'1',name:'clip2.mp4'},{key:'2',name:'clip3.mp4'}]}));
  expect(api.reference).toHaveBeenCalledTimes(2);expect(api.abandon).toHaveBeenCalledWith('new-videos','imp-aaaaaaaaaaaaaaaaaaaa',['i1','i2']);expect(api.cancel).not.toHaveBeenCalled();
});
it('browser: cancels the batch and shows the reason without opening when no video could be delivered',async()=>{
  api.reference.mockRejectedValue(new Error('保存場所を確認できませんでした'));
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  expect(await screen.findByText('保存場所を確認できませんでした')).toBeTruthy();
  expect(api.cancel).toHaveBeenCalledWith('new-videos','imp-aaaaaaaaaaaaaaaaaaaa');expect(api.abandon).not.toHaveBeenCalled();expect(navigate).not.toHaveBeenCalled();
});

// ---- Task 8 レビュー1回目 ----
const untouched={clips:[],assets:[],revision:0};
it('browser: waits until the undelivered items are marked failed before opening the project',async()=>{
  let finish!:()=>void;api.abandon.mockImplementation(()=>new Promise(done=>{finish=()=>done({});}));
  api.reference.mockImplementation(async(_id:string,body:{itemId:string})=>{if(body.itemId==='i1')throw new Error('保存場所を確認できませんでした');return {};});
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(api.abandon).toHaveBeenCalledWith('new-videos','imp-aaaaaaaaaaaaaaaaaaaa',['i1']));await act(async()=>{});
  expect(navigate).not.toHaveBeenCalled();
  await act(async()=>{finish();});await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
});
it('browser: asks once more when marking the undelivered items failed does not go through, and opens after the retry',async()=>{
  // 届かないまま開くと、渡せなかった素材が受け渡し待ちのまま残り、判断の案内も確定も止まる（再起動すると判定済みの素材まで失敗になる）
  api.abandon.mockRejectedValueOnce(new Error('接続が切れました'));
  api.reference.mockImplementation(async(_id:string,body:{itemId:string})=>{if(body.itemId==='i1')throw new Error('保存場所を確認できませんでした');return {};});
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));
  expect(api.abandon.mock.calls).toEqual([['new-videos','imp-aaaaaaaaaaaaaaaaaaaa',['i1']],['new-videos','imp-aaaaaaaaaaaaaaaaaaaa',['i1']]]);
  expect(api.abandon.mock.invocationCallOrder[1]!).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
});
it('browser: retries marking the undelivered items failed only once, then opens anyway',async()=>{
  api.abandon.mockRejectedValue(new Error('接続が切れました'));
  api.reference.mockImplementation(async(_id:string,body:{itemId:string})=>{if(body.itemId==='i1')throw new Error('保存場所を確認できませんでした');return {};});
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-videos'));expect(api.abandon).toHaveBeenCalledTimes(2);
});
it('browser: moves the untouched empty project to the trash after cancelling the batch when no video could be delivered',async()=>{
  api.reference.mockRejectedValue(new Error('保存場所を確認できませんでした'));api.saved.mockResolvedValue(untouched);
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  expect(await screen.findByText('保存場所を確認できませんでした')).toBeTruthy();
  expect(api.remove).toHaveBeenCalledWith('new-videos');expect(api.saved).toHaveBeenCalledWith('new-videos');
  expect(api.cancel.mock.invocationCallOrder[0]!).toBeLessThan(api.remove.mock.invocationCallOrder[0]!);expect(navigate).not.toHaveBeenCalled();
});
it('moves the untouched empty project to the trash when the batch cannot be made',async()=>{
  api.create.mockRejectedValue(new Error('許可された場所ではありません'));api.saved.mockResolvedValue(untouched);desktopPaths();
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  expect(await screen.findByText('許可された場所ではありません')).toBeTruthy();expect(api.remove).toHaveBeenCalledWith('new-videos');expect(navigate).not.toHaveBeenCalled();
});
it('keeps the project when it cannot confirm that the project is still untouched',async()=>{
  api.create.mockRejectedValue(new Error('許可された場所ではありません'));desktopPaths();
  for(const saved of [async()=>({...untouched,revision:1}),async()=>({...untouched,assets:[{id:'a'}]}),async()=>{throw new Error('読めません');}]){
    api.saved.mockImplementationOnce(saved);
    render(<NativeHome navigate={vi.fn()}/>);await screen.findByText('まだプロジェクトがありません');
    choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
    expect(await screen.findByText('許可された場所ではありません')).toBeTruthy();cleanup();
  }
  expect(api.saved).toHaveBeenCalledTimes(3);expect(api.remove).not.toHaveBeenCalled();
});
it('desktop copy: stops reading the lengths and forgets them when no video could be sent',async()=>{
  desktopPaths();let options!:{onRead(key:string,seconds:number):void;signal:AbortSignal};
  api.durations.mockImplementation((_files:File[],given:typeof options)=>{options=given;given.onRead('0',2);return new Promise(()=>{});});
  api.upload.mockRejectedValue(new Error('ディスクの空きが足りません'));
  render(<NativeHome navigate={vi.fn()}/>);await screen.findByText('まだプロジェクトがありません');
  choose([new File(['a'],'clip1.mp4'),new File(['b'],'clip2.mp4')]);fireEvent.click(screen.getByTestId('home-create-copy'));fireEvent.click(screen.getByRole('button',{name:'作成'}));
  expect(await screen.findByText('ディスクの空きが足りません')).toBeTruthy();
  expect(options.signal.aborted).toBe(true);expect(importSeconds('imp-aaaaaaaaaaaaaaaaaaaa','0')).toBeUndefined();
});
