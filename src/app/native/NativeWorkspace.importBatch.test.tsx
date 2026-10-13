/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
const h=vi.hoisted(()=>({append:vi.fn(),flush:vi.fn(),resolve:vi.fn(),reference:vi.fn(),upload:vi.fn(),create:vi.fn(),uploadItem:vi.fn(),durations:vi.fn(),abandon:vi.fn(),cancel:vi.fn(),confirm:vi.fn(),
  bus:null as null|((raw:unknown)=>void),timeline:null as null|{onCancelImport?(batchId:string):void;onRange(range:unknown):void;range:unknown;importFrames?:Array<{name:string;estimated:boolean;durationFrames:number}>}}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:h.flush}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((props:{onCancelImport?(batchId:string):void;onRange(range:unknown):void;range:unknown;importFrames?:Array<{name:string;estimated:boolean;durationFrames:number}>},_ref)=>{h.timeline=props;return null;})}));
vi.mock('../panels/MediaPicker',()=>({MediaPicker:(props:{onPick(file:{path:string;name:string}):void})=><div>
  <button onClick={()=>props.onPick({path:'/Volumes/media/clip3.mp4',name:'clip3.mp4'})}>pick-video</button><button onClick={()=>props.onPick({path:'/Volumes/media/theme.mp3',name:'theme.mp3'})}>pick-audio</button></div>}));
vi.mock('../eventBus',async importOriginal=>{const actual=await importOriginal<typeof import('../eventBus')>();
  return {...actual,useEventChannelWithSync:(ch:string,id:string,apply:(raw:unknown)=>void)=>{if(ch==='imports'){h.bus=apply;return;}return actual.useEventChannelWithSync(ch,id,apply);}};});
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:h.resolve,cancel(){},picker:null})}));
vi.mock('./videoDuration',()=>({readVideoDurations:h.durations}));
vi.mock('./api',async importOriginal=>({...(await importOriginal<typeof import('./api')>()),createImportBatch:h.create,uploadImportItem:h.uploadItem,abandonImportItems:h.abandon,cancelImportBatch:h.cancel}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'s',dirty:false,document:{schemaVersion:2,id:'p1',revision:0,name:'p1',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:0,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}}},busy:false,reference:h.reference,upload:h.upload,readCurrent:()=>null,confirmImport:h.confirm,appendToMain:h.append})}));
const view=(items:Array<{key:string;name:string}>,mode:'link'|'copy')=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'p1',createdAt:'x',origin:{kind:'ui'},placement:'append-main',mode,phase:'preparing',
  items:[...items].sort((a,b)=>a.name.localeCompare(b.name,'ja',{numeric:true})).map((item,index)=>({itemId:`i${index}`,key:item.key,name:item.name,phase:'waiting'}))});
beforeEach(()=>{
  Reflect.deleteProperty(window,'harnessDesktop');sessionStorage.clear();
  h.flush.mockReset().mockResolvedValue(true);h.resolve.mockReset();h.reference.mockReset().mockResolvedValue(true);h.upload.mockReset().mockResolvedValue(true);
  h.create.mockReset().mockImplementation(async(_id:string,body:{mode:'link'|'copy';items:Array<{key:string;name:string}>})=>view(body.items,body.mode));
  h.uploadItem.mockReset().mockResolvedValue({});h.durations.mockReset().mockResolvedValue(new Map([['0',2],['1',1]]));
  h.abandon.mockReset().mockResolvedValue({});h.cancel.mockReset().mockResolvedValue({});h.confirm.mockReset().mockResolvedValue(true);h.append.mockReset().mockResolvedValue({ok:true});h.bus=null;h.timeline=null;
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();Reflect.deleteProperty(window,'harnessDesktop');vi.unstubAllGlobals();});
const drop=(container:HTMLElement,files:File[])=>fireEvent.drop(container.querySelector('.native-library')!,{dataTransfer:{files}});
it('desktop: links dropped videos by their real paths without hashing them in the browser, with the pre-read lengths',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/media/${file.name}`}});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.create).toHaveBeenCalledTimes(1));
  expect(h.create.mock.calls[0]![1]).toMatchObject({mode:'link',origin:'ui',items:[{key:'0',name:'clip2.mp4',path:'/Volumes/media/clip2.mp4'},{key:'1',name:'clip10.mp4',path:'/Volumes/media/clip10.mp4'}]});
  expect(h.resolve).not.toHaveBeenCalled();expect(h.reference).not.toHaveBeenCalled();expect(h.uploadItem).not.toHaveBeenCalled();expect(h.durations).toHaveBeenCalledTimes(1);
});
it('browser: copies dropped videos into the batch in its fixed order',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>),files=[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')];drop(rendered.container,files);
  await waitFor(()=>expect(h.uploadItem).toHaveBeenCalledTimes(2));
  expect(h.create.mock.calls[0]![1]).toMatchObject({mode:'copy',items:[{key:'0',name:'clip2.mp4'},{key:'1',name:'clip10.mp4'}]});
  expect(h.uploadItem.mock.calls.map(call=>[call[2],(call[3] as File).name])).toEqual([['i0','clip2.mp4'],['i1','clip10.mp4']]);
  expect(h.upload).not.toHaveBeenCalled();
});
it('mixed files: videos go to the batch, the others keep the existing import',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/media/${file.name}`}});
  h.resolve.mockResolvedValue({path:'/Volumes/media/theme.mp3',expectedFingerprint:'a'.repeat(64)});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['m'],'theme.mp3'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.reference).toHaveBeenCalledWith('/Volumes/media/theme.mp3','a'.repeat(64),expect.any(Function),undefined));
  expect(h.create.mock.calls[0]![1].items).toEqual([{key:'0',name:'clip2.mp4',path:'/Volumes/media/clip2.mp4'}]);
});
it('does not create a batch after leaving during the input flush',async()=>{
  let finish!:(ok:boolean)=>void;h.flush.mockImplementation(()=>new Promise<boolean>(done=>{finish=done;}));
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.flush).toHaveBeenCalled());rendered.unmount();await act(async()=>{finish(true);});
  expect(h.create).not.toHaveBeenCalled();
});

// ---- Task 7 申し送り ----
it('keeps the reason of a failed upload, sends the rest, reports the undelivered item, and never appends unregistered IDs',async()=>{
  const {NativeApiError}=await import('./api');
  h.uploadItem.mockImplementation(async(_p:string,_b:string,itemId:string)=>{if(itemId==='i0')throw new NativeApiError('ディスクの空きが足りません',507);return {};});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(rendered.getByRole('alert').textContent).toContain('ディスクの空きが足りません'));
  expect(h.uploadItem.mock.calls.map(call=>call[2])).toEqual(['i0','i1']);
  expect(h.abandon).toHaveBeenCalledWith('p1','imp-aaaaaaaaaaaaaaaaaaaa',['i0']);
  expect(h.append).not.toHaveBeenCalled();
});
it('asks once more when marking the undelivered item failed does not go through, and only once',async()=>{
  const {NativeApiError}=await import('./api');
  h.uploadItem.mockImplementation(async(_p:string,_b:string,itemId:string)=>{if(itemId==='i0')throw new NativeApiError('ディスクの空きが足りません',507);return {};});
  h.abandon.mockRejectedValueOnce(new Error('接続が切れました'));
  const first=render(<NativeWorkspace projectId="p1"/>);drop(first.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.abandon).toHaveBeenCalledTimes(2));expect(h.abandon.mock.calls[1]).toEqual(['p1','imp-aaaaaaaaaaaaaaaaaaaa',['i0']]);
  first.unmount();h.abandon.mockReset().mockRejectedValue(new Error('接続が切れました'));
  const second=render(<NativeWorkspace projectId="p1"/>);drop(second.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.abandon).toHaveBeenCalledTimes(2));await act(async()=>{});expect(h.abandon).toHaveBeenCalledTimes(2);
});
it('stops sending to a batch cancelled from its frame, without a notice',async()=>{
  let first!:{signal:AbortSignal;fail:(error:unknown)=>void};
  h.uploadItem.mockImplementation((_p:string,_b:string,itemId:string,_f:File,_progress:unknown,signal:AbortSignal)=>itemId==='i0'?new Promise((_resolve,reject)=>{first={signal,fail:reject};}):Promise.resolve({}));
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.uploadItem).toHaveBeenCalledTimes(1));expect(first.signal.aborted).toBe(false);
  await act(async()=>{h.timeline!.onCancelImport!('imp-aaaaaaaaaaaaaaaaaaaa');});
  await waitFor(()=>expect(first.signal.aborted).toBe(true));
  const {NativeApiError}=await import('./api');await act(async()=>{first.fail(new NativeApiError('取り込みを中止しました。',0));});
  expect(h.uploadItem).toHaveBeenCalledTimes(1);expect(rendered.queryByRole('alert')).toBeNull();
});
it('stops quietly when the server says the batch no longer takes deliveries',async()=>{
  const {NativeApiError}=await import('./api');
  h.uploadItem.mockRejectedValue(new NativeApiError('この取り込みは受け付けを終えています',409,'IMPORT_CLOSED'));
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.uploadItem).toHaveBeenCalledTimes(1));await act(async()=>{});
  expect(h.uploadItem).toHaveBeenCalledTimes(1);expect(rendered.queryByRole('alert')).toBeNull();
});
it('reports the items it did not send after leaving the project during the uploads',async()=>{
  let finish!:()=>void;h.uploadItem.mockImplementation((_p:string,_b:string,itemId:string)=>itemId==='i0'?new Promise(resolve=>{finish=()=>resolve({});}):Promise.resolve({}));
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.uploadItem).toHaveBeenCalledTimes(1));rendered.unmount();await act(async()=>{finish();});
  expect(h.uploadItem).toHaveBeenCalledTimes(1);expect(h.abandon).toHaveBeenCalledWith('p1','imp-aaaaaaaaaaaaaaaaaaaa',['i1']);
});
it('「素材を追加」 (a linked reference, the desktop default) puts a chosen video into a batch for the main end; other media keep the plain reference',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);
  fireEvent.click(rendered.getByRole('tab',{name:'素材'}));fireEvent.click(await rendered.findByRole('button',{name:'素材を追加'}));
  fireEvent.click(await rendered.findByRole('button',{name:'pick-video'}));
  await waitFor(()=>expect(h.create).toHaveBeenCalledTimes(1));
  expect(h.create.mock.calls[0]![1]).toMatchObject({mode:'link',origin:'ui',items:[{key:'0',name:'clip3.mp4',path:'/Volumes/media/clip3.mp4'}]});
  expect(h.reference).not.toHaveBeenCalled();
  // 自分の束として覚えている: 準備が終わると自動で確定する
  await act(async()=>{h.bus!({type:'list',batches:[{...view([{key:'0',name:'clip3.mp4'}],'link'),phase:'ready',items:[{itemId:'i0',key:'0',name:'clip3.mp4',phase:'ready',assetId:'media-c'}]}]});});
  await waitFor(()=>expect(h.confirm).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa',false));
  fireEvent.click(await rendered.findByRole('button',{name:'素材を追加'}));fireEvent.click(await rendered.findByRole('button',{name:'pick-audio'}));
  await waitFor(()=>expect(h.reference).toHaveBeenCalledWith('/Volumes/media/theme.mp3',undefined,expect.any(Function)));expect(h.create).toHaveBeenCalledTimes(1);
});
it('tells which audio-only files were only added to the materials when its batch is placed',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/media/${file.name}`}});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'take.mp4'),new File(['a'],'voice.mp4')]);
  await waitFor(()=>expect(h.create).toHaveBeenCalledTimes(1));
  await act(async()=>{h.bus!({type:'list',batches:[{...view([{key:'0',name:'take.mp4'},{key:'1',name:'voice.mp4'}],'link'),phase:'ready',
    items:[{itemId:'i0',key:'0',name:'take.mp4',phase:'ready',assetId:'media-t'},{itemId:'i1',key:'1',name:'voice.mp4',phase:'ready',assetId:'media-v',audioOnly:true}]}]});});
  await waitFor(()=>expect(rendered.getByRole('alert').textContent).toBe('「voice.mp4」は映像が無いため、メインには並べず素材の一覧に追加しました。'));
});
it('clears the range selection after placing a ready batch by hand',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);fireEvent.click(rendered.getByRole('tab',{name:'素材'}));
  await waitFor(()=>expect(h.bus).not.toBeNull());
  await act(async()=>{h.bus!({type:'list',batches:[{...view([{key:'0',name:'other.mp4'}],'link'),phase:'ready',items:[{itemId:'i0',key:'0',name:'other.mp4',phase:'ready',assetId:'media-o'}]}]});});
  const range={trackId:'v-main',startFrame:10,endFrame:20};act(()=>{h.timeline!.onRange(range);});expect(h.timeline!.range).toEqual(range);
  expect(h.confirm).not.toHaveBeenCalled();
  fireEvent.click(await rendered.findByRole('button',{name:'メインの末尾に並べる'}));
  await waitFor(()=>expect(h.confirm).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa',false));await waitFor(()=>expect(h.timeline!.range).toBeNull());
});
it('cancels the batch when none of its videos could be sent, and keeps the reason',async()=>{
  const {NativeApiError}=await import('./api');h.uploadItem.mockRejectedValue(new NativeApiError('ファイルが大きすぎます',413));
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(rendered.getByRole('alert').textContent).toContain('ファイルが大きすぎます'));
  expect(h.cancel).toHaveBeenCalledWith('p1','imp-aaaaaaaaaaaaaaaaaaaa');expect(h.abandon).not.toHaveBeenCalled();
});
it('desktop 「コピーして追加」 sends the videos from the screen (no server copy from the real path, so files outside the allowed places still work)',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Users/x/Documents/${file.name}`}});
  const rendered=render(<NativeWorkspace projectId="p1"/>),files=[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')];
  fireEvent.change(rendered.container.querySelector('input[multiple]')!,{target:{files}});
  await waitFor(()=>expect(h.uploadItem).toHaveBeenCalledTimes(2));
  expect(h.create.mock.calls[0]![1]).toMatchObject({mode:'copy',items:[{key:'0',name:'clip2.mp4'},{key:'1',name:'clip10.mp4'}]});
  expect(h.create.mock.calls[0]![1].items.some((item:{path?:string})=>item.path!==undefined)).toBe(false);
});

// ---- Task 8 申し送り ----
it('desktop: asks for the batch without waiting for the length pre-read, and shows each length as it arrives',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/media/${file.name}`}});
  let report!:(key:string,seconds:number)=>void;
  h.durations.mockImplementation((_files:File[],options:{onRead(key:string,seconds:number):void})=>{report=options.onRead;return new Promise(()=>{});});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.create).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(h.timeline!.importFrames?.map(frame=>[frame.name,frame.estimated])).toEqual([['clip2.mp4',true],['clip10.mp4',true]]));
  await act(async()=>{report('1',1);});
  expect(h.timeline!.importFrames!.map(frame=>[frame.name,frame.estimated,frame.durationFrames])).toEqual([['clip2.mp4',true,150],['clip10.mp4',false,30]]);
  await waitFor(()=>expect(rendered.container.querySelector('.native-file-drop strong')!.textContent).toBe('2件の素材を追加しました'));
});
it('tells how many videos were sent when only some of them could be sent',async()=>{
  const {NativeApiError}=await import('./api');
  h.uploadItem.mockImplementation(async(_p:string,_b:string,itemId:string)=>{if(itemId==='i0')throw new NativeApiError('ディスクの空きが足りません',507);return {};});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(rendered.container.querySelector('.native-file-drop strong')!.textContent).toBe('1 / 2件を追加しました'));
  expect(rendered.getByRole('alert').textContent).toContain('ディスクの空きが足りません');
});
it('lets go of the upload signal once the videos are sent (a later cancel does not reach a finished upload)',async()=>{
  const signals:AbortSignal[]=[];h.uploadItem.mockImplementation(async(_p:string,_b:string,_i:string,_f:File,_progress:unknown,signal:AbortSignal)=>{signals.push(signal);return {};});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(rendered.container.querySelector('.native-file-drop strong')!.textContent).toBe('2件の素材を追加しました'));
  await act(async()=>{h.bus!({type:'list',batches:[{...view([{key:'0',name:'clip2.mp4'},{key:'1',name:'clip10.mp4'}],'copy'),phase:'cancelled',
    items:[{itemId:'i0',key:'0',name:'clip2.mp4',phase:'cancelled'},{itemId:'i1',key:'1',name:'clip10.mp4',phase:'cancelled'}]}]});});
  expect(signals.map(signal=>signal.aborted)).toEqual([false,false]);
});
it('stops reading the lengths when leaving the project',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/Volumes/media/${file.name}`}});
  let signal!:AbortSignal;h.durations.mockImplementation((_files:File[],options:{signal:AbortSignal})=>{signal=options.signal;return new Promise(()=>{});});
  const rendered=render(<NativeWorkspace projectId="p1"/>);drop(rendered.container,[new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  await waitFor(()=>expect(h.create).toHaveBeenCalledTimes(1));expect(signal.aborted).toBe(false);
  rendered.unmount();expect(signal.aborted).toBe(true);
});

// ---- Task 13 裁定: 開いた時に確定を促す（設計 §1）----
// 案件を開いて最初に一覧が届いた時、促す束（準備済み・未配置／失敗を含む／確定の印があるのに文書に無い）があれば、左の欄を素材タブへ1回だけ切り替える。
type Batch={batchId:string;projectId:string;createdAt:string;origin:{kind:'ui'}|{kind:'home'}|{kind:'agent';operationId:string};placement:'append-main';mode:'link';phase:string;
  items:Array<{itemId:string;key:string;name:string;phase:string;assetId?:string;error?:string}>;confirmed?:{executionId:string;revision:number}};
const batch=(batchId:string,name:string,extra:Partial<Batch>={}):Batch=>({batchId,projectId:'p1',createdAt:'x',origin:{kind:'ui'},placement:'append-main',mode:'link',phase:'ready',
  items:[{itemId:'i0',key:'0',name,phase:'ready',assetId:`media-${name}`}],...extra});
const selectedTab=(rendered:ReturnType<typeof render>)=>rendered.getAllByRole('tab').filter(tab=>tab.closest('.native-library-tabs')&&tab.getAttribute('aria-selected')==='true').map(tab=>tab.textContent);
const list=async(batches:Batch[])=>{await waitFor(()=>expect(h.bus).not.toBeNull());await act(async()=>{h.bus!({type:'list',batches});});};
it.each([
  ['a ready batch made while the project was closed',batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4'),'準備済み・未配置（1本）'],
  ['a batch with a failed item',batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4',{phase:'partial',items:[{itemId:'i0',key:'0',name:'away.mp4',phase:'ready',assetId:'media-a'},{itemId:'i1',key:'1',name:'bad.mp4',phase:'failed',error:'壊れています'}]}),'1本を準備できませんでした（1本は準備済み）'],
  ['a confirmed batch missing from the document',batch('imp-bbbbbbbbbbbbbbbbbbbb','lost.mp4',{phase:'confirmed',confirmed:{executionId:'e',revision:1}}),null],
] as const)('opens the materials tab once when the first list on opening has %s',async(_label,first,text)=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);expect(selectedTab(rendered)).toEqual(['プロジェクト']);
  await list([first]);
  await waitFor(()=>expect(selectedTab(rendered)).toEqual(['素材']));
  if(text){expect(rendered.getByText(text)).toBeTruthy();expect(rendered.getByRole('button',{name:first.phase==='ready'?'メインの末尾に並べる':'失敗分を除いて並べる'})).toBeTruthy();}
  expect(h.confirm).not.toHaveBeenCalled();
});
it('keeps the current tab when the first list on opening has nothing to place',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','done.mp4',{phase:'cancelled',items:[{itemId:'i0',key:'0',name:'done.mp4',phase:'cancelled'}]})]);
  await act(async()=>{});expect(selectedTab(rendered)).toEqual(['プロジェクト']);
});
it('does not switch for a batch that arrives while the project is open (only the first list decides)',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);await list([]);
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','later.mp4')]);await act(async()=>{});
  expect(rendered.getByText('準備済み・未配置（1本）')).toBeTruthy();expect(selectedTab(rendered)).toEqual(['プロジェクト']);
});
it('does not switch again after the user moved to another tab',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4')]);
  await waitFor(()=>expect(selectedTab(rendered)).toEqual(['素材']));
  fireEvent.click(rendered.getByRole('tab',{name:'プロジェクト'}));expect(selectedTab(rendered)).toEqual(['プロジェクト']);
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4'),batch('imp-cccccccccccccccccccc','next.mp4')]);await act(async()=>{});
  expect(selectedTab(rendered)).toEqual(['プロジェクト']);
});
it('does not switch for batches that are placed automatically (home and the agent)',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','home.mp4',{origin:{kind:'home'}}),batch('imp-cccccccccccccccccccc','agent.mp4',{origin:{kind:'agent',operationId:'op'}})]);
  await waitFor(()=>expect(h.confirm).toHaveBeenCalledTimes(2));await act(async()=>{});
  expect(selectedTab(rendered)).toEqual(['プロジェクト']);
});
it('respects a tab the user chose before the first list arrives',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);
  fireEvent.click(rendered.getByRole('tab',{name:'素材'}));fireEvent.click(rendered.getByRole('tab',{name:'プロジェクト'}));
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4')]);await act(async()=>{});
  expect(selectedTab(rendered)).toEqual(['プロジェクト']);
});
it('decides again when the project is opened again after another one',async()=>{
  const rendered=render(<NativeWorkspace projectId="p1"/>);await list([]);
  rendered.rerender(<NativeWorkspace projectId="p2"/>);await act(async()=>{});rendered.rerender(<NativeWorkspace projectId="p1"/>);await act(async()=>{});
  await list([batch('imp-bbbbbbbbbbbbbbbbbbbb','away.mp4')]);
  await waitFor(()=>expect(selectedTab(rendered)).toEqual(['素材']));
});
