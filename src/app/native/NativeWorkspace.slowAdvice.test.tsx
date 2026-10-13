/** @vitest-environment jsdom */
// 案内（設計 §1・§2）: 開いた時は素材の欄に、追加時は判断待ちの束に。照合のエラーのバナーがある時はそちらが上。
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {CopyJobView,SlowMediaAdvice} from '../../shared/mediaCopy';
import type {ImportBatchView} from '../../shared/importBatches';
import {NativeWorkspace} from './NativeWorkspace';
import {slowAdviceTesting} from './useSlowMediaAdvice';

const h=vi.hoisted(()=>({busy:false,imports:null as null|((raw:unknown)=>void),jobs:null as null|((raw:unknown)=>void)}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('../eventBus',async importOriginal=>{const actual=await importOriginal<typeof import('../eventBus')>();
  return {...actual,useEventChannelWithSync:(ch:string,id:string,apply:(raw:unknown)=>void)=>{if(ch==='imports')h.imports=apply;if(ch==='copy-jobs')h.jobs=apply;return actual.useEventChannelWithSync(ch,id,apply);}};});
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
const audition=vi.hoisted(()=>({playingId:null,toggle(){},stop(){}}));
vi.mock('./useAssetAudition',()=>({useAssetAudition:()=>audition}));
const linked=(id:string,name:string,hex:string)=>({id,name,file:`.harness/references/${hex.repeat(64)}.wav`,kind:'media',fingerprint:hex.repeat(64),
  streams:[{kind:'audio',index:0,codec:'pcm_s16le',sampleRate:48000,channels:2,duration:{num:2,den:1}}]});
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'linked',revision:0,name:'linked',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
  assets:[linked('r1','SD1.wav','a'),linked('r2','SD2.wav','b')],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
}},busy:h.busy,execute:vi.fn(async()=>true),readCurrent:()=>({document:null}),save:vi.fn(async()=>true),confirmImport:vi.fn(async()=>true)})}));
const GiB=2**30;
let advice:SlowMediaAdvice,states:Record<string,string>={},suppressStatus=200;
const requests:Array<{route:string;body:unknown}>=[];
const target=(assetId:string,name:string,canRemember?:false)=>({assetId,name,sizeBytes:GiB,seconds:120,...(canRemember===false?{canRemember}:{})});
beforeEach(()=>{
  sessionStorage.clear();slowAdviceTesting.forget();states={r1:'checking',r2:'checking'};requests.length=0;h.busy=false;h.imports=null;h.jobs=null;suppressStatus=200;
  advice={targets:[target('r1','SD1.wav'),target('r2','SD2.wav')],totalBytes:2*GiB,totalSeconds:240,unmeasured:0};
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    const at=new URL(url,'http://localhost'),body=init?.body?JSON.parse(String(init.body)):undefined,route=at.pathname.slice('/api/sequence'.length);
    if(at.pathname==='/api/sequence/reference/status')return {ok:true,json:async()=>({state:states[at.searchParams.get('asset')!]})};
    if(route==='/media-copy/advice')return {ok:true,json:async()=>advice};
    if(route.startsWith('/media-copy/')||route.startsWith('/imports/')){requests.push({route,body});
      if(route==='/media-copy/suppress')return {ok:suppressStatus===200,status:suppressStatus,json:async()=>suppressStatus===200?{ok:true}:{error:'素材のドライブを識別できないため、「今後この場所では出さない」を記録できません'}};
      if(route==='/media-copy/destinations')return {ok:true,json:async()=>({totalBytes:2*GiB,destinations:[{key:'internal',label:'このMac（ムービー）',volume:{uuid:'BOOT',dev:1},
        space:{free:300*GiB,capacity:500*GiB,after:298*GiB,margin:50*GiB},selectable:true,time:{minSeconds:60,maxSeconds:120},recommended:true}]})};
      return {ok:true,json:async()=>({})};
    }
    return {ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const open=()=>{const view=render(<NativeWorkspace projectId="linked"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));return view;};
const adviceBox=(view:ReturnType<typeof open>)=>view.container.querySelector<HTMLElement>('[data-slow-media-advice]');
const routes=()=>requests.map(request=>request.route);

it('shows the advice in the materials panel and copies its targets through the destination dialog',async()=>{
  const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  const box=adviceBox(view)!;expect(box.closest('#native-panel-materials')).not.toBeNull();expect(box.textContent).toContain('この素材（2本・合計 2.0 GB）は読み込みに時間がかかる場所にあります');
  fireEvent.click(within(box).getByRole('button',{name:'コピーして使う'}));
  const dialog=await view.findByRole('dialog',{name:'コピー先を選ぶ'});await within(dialog).findByText('おすすめ');
  expect(requests[0]).toEqual({route:'/media-copy/destinations',body:{assetIds:['r1','r2']}});
  fireEvent.click(within(dialog).getByRole('button',{name:'コピーを始める'}));await waitFor(()=>expect(view.queryByRole('dialog',{name:'コピー先を選ぶ'})).toBeNull());
  expect(requests[1]).toEqual({route:'/media-copy/start',body:{assetIds:['r1','r2'],destination:{key:'internal',uuid:'BOOT',dev:1}}});
});
it('"このまま使う" puts the advice away for this time without asking the server',async()=>{
  const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  fireEvent.click(within(adviceBox(view)!).getByRole('button',{name:'このまま使う'}));
  expect(adviceBox(view)).toBeNull();expect(routes()).toEqual([]);
});
const keepAlways=(view:ReturnType<typeof open>)=>{const box=within(adviceBox(view)!);fireEvent.click(box.getByRole('checkbox',{name:'今後この場所では出さない'}));fireEvent.click(box.getByRole('button',{name:'このまま使う'}));};
it('"今後この場所では出さない" records only the assets whose drive can be told apart',async()=>{
  advice={...advice,targets:[target('r1','SD1.wav'),target('r2','SD2.wav',false)]};
  const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  keepAlways(view);
  await waitFor(()=>expect(adviceBox(view)).toBeNull());expect(requests).toEqual([{route:'/media-copy/suppress',body:{assetId:'r1'}}]);
});
it('keeps the advice and tells the reason when the server cannot record "not again"',async()=>{
  suppressStatus=409;advice={...advice,targets:[target('r1','SD1.wav')]};
  const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  keepAlways(view);
  expect(await view.findByText('素材のドライブを識別できないため、「今後この場所では出さない」を記録できません')).toBeTruthy();expect(adviceBox(view)).not.toBeNull();
});
it('leaves out the assets this editor is copying, and puts the reference error banner above the advice',async()=>{
  states={r1:'missing',r2:'checking'};const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  const banner=view.container.querySelector('.native-reference-notice')!;expect(banner).not.toBeNull();
  expect(banner.compareDocumentPosition(adviceBox(view)!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(()=>expect(h.jobs).not.toBeNull());
  const job:CopyJobView={jobId:'cp-00000000000000000000',projectId:'linked',mode:'reconnect',state:'running',createdAt:'x',destination:{kind:'volume',label:'SSD'},
    items:[{itemId:'c0',name:'SD2.wav',sizeBytes:GiB,phase:'copying',bytesDone:0,assetId:'r2'}]};
  act(()=>h.jobs!({type:'list',jobs:[job]}));
  expect(adviceBox(view)!.textContent).toContain('この素材は読み込みに時間がかかる場所にあります');expect(within(adviceBox(view)!).queryByText(/SD2.wav/)).toBeNull();
});
// 「今回はこのまま」の引き継ぎは、このページで判断待ちとして見た束だけ（ディスクに残る前の画面の束は引き継がない＝読み直すと再び出る。設計 §2「この画面を閉じるまで」）。
const added=(projectId:string,phase:ImportBatchView['phase'],item:Partial<ImportBatchView['items'][number]>,patch:Partial<ImportBatchView>={}):ImportBatchView=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId,createdAt:'x',origin:{kind:'ui'},
  placement:'append-main',mode:'link',phase,items:[{itemId:'i0',key:'0',name:'SD1.wav',phase:'ready',...item}],...patch});
const waitingFor=(projectId:string)=>added(projectId,'deciding',{phase:'awaiting-decision',slow:{sizeBytes:GiB,seconds:120}},{decision:{itemIds:['i0'],totalBytes:GiB,totalSeconds:120}});
const keptOnce=(projectId:string,choice:'keep-once'|'keep-always'='keep-once')=>added(projectId,'confirmed',{assetId:'r1',choice},{confirmed:{executionId:'e',revision:0}});
const names=(view:ReturnType<typeof open>)=>Array.from(adviceBox(view)?.querySelectorAll('li')??[],item=>item.textContent);
it('does not show the advice again for an asset added with "このまま使う" in a batch this page asked about',async()=>{
  const view=open();await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[waitingFor('linked')]}));act(()=>h.imports!({type:'list',batches:[keptOnce('linked')]}));
  await waitFor(()=>expect(adviceBox(view)).not.toBeNull());expect(names(view)).toEqual(['SD2.wav']);
});
it('shows the advice again after the page is read again, and leaves "not again" to the server',async()=>{
  const first=open();await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[waitingFor('linked')]}));act(()=>h.imports!({type:'list',batches:[keptOnce('linked')]}));
  await waitFor(()=>expect(names(first)).toEqual(['SD2.wav']));first.unmount();
  slowAdviceTesting.forget();   // 読み直し（ページの記憶が消える）。束はディスクに残り、一覧で届く
  const again=open();await waitFor(()=>expect(h.imports).not.toBeNull());act(()=>h.imports!({type:'list',batches:[keptOnce('linked')]}));
  await waitFor(()=>expect(names(again)).toEqual(['SD1.wav（約2分）','SD2.wav（約2分）']));
  // 「今後この場所では出さない」はサーバが案内から外す（画面は引き継がない）
  act(()=>h.imports!({type:'list',batches:[waitingFor('linked')]}));act(()=>h.imports!({type:'list',batches:[keptOnce('linked','keep-always')]}));
  await act(async()=>{});expect(names(again)).toEqual(['SD1.wav（約2分）','SD2.wav（約2分）']);
});
it('does not carry a choice made in another project over to this one',async()=>{
  const view=render(<NativeWorkspace projectId="linked"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[waitingFor('linked')]}));act(()=>h.imports!({type:'list',batches:[keptOnce('linked')]}));
  await waitFor(()=>expect(names(view)).toEqual(['SD2.wav']));
  view.rerender(<NativeWorkspace projectId="other"/>);   // 切り替えた直後の描画には前の案件の束が残る
  await waitFor(()=>expect(names(view)).toEqual(['SD1.wav（約2分）','SD2.wav（約2分）']));
});
it('leaves out the targets that are not in the current document',async()=>{
  advice={targets:[target('r1','SD1.wav'),target('r9','gone.wav')],totalBytes:2*GiB,totalSeconds:240,unmeasured:0};
  const view=open();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());
  expect(names(view)).toEqual(['SD1.wav']);expect(adviceBox(view)!.textContent).toContain('この素材は読み込みに時間がかかる場所にあります（確認に約2分の見込み）');
});
// 素材置場の表示でも、案内・判断待ちの束・コピーの進み具合は置き場の切替より上に見える（素材置場を常用する利用者がいる）。
it('shows the advice and a batch waiting for a decision above the source switch, also while the library is shown',async()=>{
  localStorage.setItem('harness.native.materialSource','library');
  try{
    const view=open();expect(view.getByRole('radio',{name:'素材置場'}).getAttribute('aria-checked')).toBe('true');
    await waitFor(()=>expect(adviceBox(view)).not.toBeNull());await waitFor(()=>expect(h.imports).not.toBeNull());
    act(()=>h.imports!({type:'list',batches:[{...waitingFor('linked'),batchId:'imp-bbbbbbbbbbbbbbbbbbbb'}]}));
    const decision=view.container.querySelector('[data-import-decision]')!,source=view.container.querySelector('.native-material-source')!;
    expect(decision).not.toBeNull();expect(decision.compareDocumentPosition(source)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(adviceBox(view)!.compareDocumentPosition(source)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }finally{localStorage.removeItem('harness.native.materialSource');}
});

// ---- 追加時: 判断待ちの束 ----
const deciding=(patch:Partial<ImportBatchView>={}):ImportBatchView=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'linked',createdAt:'x',origin:{kind:'home'},placement:'append-main',mode:'link',phase:'deciding',
  items:[{itemId:'i0',key:'0',name:'take-1.mp4',phase:'awaiting-decision',slow:{sizeBytes:GiB,seconds:120}},{itemId:'i1',key:'1',name:'take-2.mp4',phase:'ready',assetId:'r9'}],
  decision:{itemIds:['i0'],totalBytes:GiB,totalSeconds:120},...patch});
const decisionBox=(view:ReturnType<typeof open>)=>view.container.querySelector<HTMLElement>('[data-import-decision]');
it('asks once per batch in the materials panel; "コピーして使う" chooses the place and decides copy with it',async()=>{
  advice={...advice,targets:[]};const view=open();await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[deciding()]}));
  const box=decisionBox(view)!;expect(box.closest('#native-panel-materials')).not.toBeNull();expect(view.container.querySelectorAll('[data-import-decision]')).toHaveLength(1);
  fireEvent.click(within(box).getByRole('button',{name:'コピーして使う'}));
  const dialog=await view.findByRole('dialog',{name:'コピー先を選ぶ'});await within(dialog).findByText('おすすめ');
  expect(requests[0]).toEqual({route:'/media-copy/destinations',body:{batchId:'imp-aaaaaaaaaaaaaaaaaaaa'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'コピーを始める'}));await waitFor(()=>expect(view.queryByRole('dialog',{name:'コピー先を選ぶ'})).toBeNull());
  expect(requests[1]).toEqual({route:'/imports/decide',body:{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',choice:'copy',destination:{key:'internal',uuid:'BOOT',dev:1}}});
});
it('decides keep-once and keep-always from the batch, and cancels a batch waiting for a decision',async()=>{
  advice={...advice,targets:[]};const view=open();await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[deciding()]}));
  fireEvent.click(within(decisionBox(view)!).getByRole('button',{name:'このまま使う'}));
  await waitFor(()=>expect(requests).toEqual([{route:'/imports/decide',body:{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',choice:'keep-once'}}]));
  act(()=>h.imports!({type:'list',batches:[deciding({batchId:'imp-bbbbbbbbbbbbbbbbbbbb'})]}));
  fireEvent.click(within(decisionBox(view)!).getByRole('checkbox',{name:'今後この場所では出さない'}));fireEvent.click(within(decisionBox(view)!).getByRole('button',{name:'このまま使う'}));
  await waitFor(()=>expect(requests[1]).toEqual({route:'/imports/decide',body:{batchId:'imp-bbbbbbbbbbbbbbbbbbbb',choice:'keep-always'}}));
  fireEvent.click(view.getByRole('button',{name:'束を取り消す'}));
  await waitFor(()=>expect(requests[2]).toEqual({route:'/imports/cancel',body:{batchId:'imp-bbbbbbbbbbbbbbbbbbbb'}}));
});
it('shows the advice of a batch waiting for a decision when the project opens (it moves to the materials tab)',async()=>{
  advice={...advice,targets:[]};const view=render(<NativeWorkspace projectId="linked"/>);await waitFor(()=>expect(h.imports).not.toBeNull());
  act(()=>h.imports!({type:'list',batches:[deciding()]}));
  await waitFor(()=>expect(view.getByRole('tab',{name:'素材'}).getAttribute('aria-selected')).toBe('true'));expect(decisionBox(view)).not.toBeNull();
});

// ---- 開いた時に案内がある時は、左の欄を「素材」タブへ1回だけ切り替える（2026-10-06 決定。取り込みの「準備済み・未配置」の促しと同じ規則） ----
const selected=(view:ReturnType<typeof open>,name:string)=>view.getByRole('tab',{name}).getAttribute('aria-selected')==='true';
it('moves the left panel to the materials tab once when the advice first arrives after opening',async()=>{
  const view=render(<NativeWorkspace projectId="linked"/>);expect(selected(view,'プロジェクト')).toBe(true);
  await waitFor(()=>expect(adviceBox(view)).not.toBeNull());await waitFor(()=>expect(selected(view,'素材')).toBe(true));
  fireEvent.click(view.getByRole('tab',{name:'プロジェクト'}));
  advice={...advice,targets:[target('r1','SD1.wav')]};states={r1:'checking',r2:'copying'};   // 案内が取り直されても、もう切り替えない
  await waitFor(()=>expect(adviceBox(view)!.textContent).toContain('この素材は'),{timeout:4000});expect(selected(view,'プロジェクト')).toBe(true);
});
it('does not move the left panel when the tab was chosen before the advice arrived',async()=>{
  const view=render(<NativeWorkspace projectId="linked"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));fireEvent.click(view.getByRole('tab',{name:'プロジェクト'}));
  expect(adviceBox(view)).toBeNull();await waitFor(()=>expect(adviceBox(view)).not.toBeNull());await act(async()=>{});expect(selected(view,'プロジェクト')).toBe(true);
});
it('does not move the left panel while there is no advice to show',async()=>{
  advice={...advice,targets:[],unmeasured:2};const view=render(<NativeWorkspace projectId="linked"/>);
  const asked=()=>(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url])=>String(url).includes('/media-copy/advice'));
  await waitFor(()=>expect(asked()).toBe(true));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
  expect(adviceBox(view)).toBeNull();expect(selected(view,'プロジェクト')).toBe(true);
});
