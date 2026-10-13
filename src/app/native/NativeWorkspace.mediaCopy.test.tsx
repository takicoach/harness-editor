/** @vitest-environment jsdom */
// 速いドライブへのコピーの入口と進み具合（設計 §1・§6）。素材行の「速いドライブへコピー」→コピー先を選ぶ→開始、コピー中は押せない。
import {forwardRef,useEffect,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {CopyJobView} from '../../shared/mediaCopy';
import {NativeWorkspace} from './NativeWorkspace';

const h=vi.hoisted(()=>({busy:false,mounts:0,playback:null as null|((playing:boolean)=>void),bus:null as null|((raw:unknown)=>void)}));
// プレビューは素材を読み直すたびに作り直される（key に mediaGeneration）。作られた回数で読み直しを数える。
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:{onPlaybackChanged(playing:boolean):void},ref)=>{h.playback=props.onPlaybackChanged;useEffect(()=>{h.mounts++;},[]);
  useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('../eventBus',async importOriginal=>{const actual=await importOriginal<typeof import('../eventBus')>();
  return {...actual,useEventChannelWithSync:(ch:string,id:string,apply:(raw:unknown)=>void)=>{if(ch==='copy-jobs')h.bus=apply;return actual.useEventChannelWithSync(ch,id,apply);}};});
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
}},busy:h.busy,execute:vi.fn(async()=>true),readCurrent:()=>({document:null}),save:vi.fn(async()=>true)})}));
const GiB=2**30;
let jobs:CopyJobView[]=[],states:Record<string,string>={},dismissStatus=409;
const requests:Array<{route:string;body:unknown}>=[];
const job=(patch:Partial<CopyJobView>):CopyJobView=>({jobId:'cp-00000000000000000000',projectId:'linked',mode:'reconnect',state:'running',createdAt:'x',destination:{kind:'volume',label:'SSD'},
  items:[{itemId:'c0',name:'SD1.wav',sizeBytes:GiB,phase:'copying',bytesDone:0,assetId:'r1'}],...patch});
beforeEach(()=>{
  sessionStorage.clear();jobs=[];states={r1:'ok',r2:'ok'};requests.length=0;h.busy=false;h.mounts=0;h.playback=null;h.bus=null;dismissStatus=409;
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    const at=new URL(url,'http://localhost'),body=init?.body?JSON.parse(String(init.body)):undefined;
    if(at.pathname==='/api/sequence/reference/status')return {ok:true,json:async()=>({state:states[at.searchParams.get('asset')!]})};
    if(at.pathname==='/api/events/sync'&&at.searchParams.get('ch')==='copy-jobs')return {ok:true,json:async()=>({messages:[{type:'list',jobs}]})};
    // 開いた時の案内（Task 15）は別の試験（NativeWorkspace.slowAdvice）で見る。ここでは案内なし。
    if(at.pathname==='/api/sequence/media-copy/advice')return {ok:true,json:async()=>({targets:[],totalBytes:0,totalSeconds:0,unmeasured:0})};
    if(at.pathname.startsWith('/api/sequence/media-copy/')){requests.push({route:at.pathname.slice('/api/sequence'.length),body});
      if(at.pathname.endsWith('/destinations'))return {ok:true,json:async()=>({totalBytes:2*GiB,destinations:[{key:'internal',label:'このMac（ムービー）',volume:{uuid:'BOOT',dev:1},
        space:{free:300*GiB,capacity:500*GiB,after:298*GiB,margin:50*GiB},selectable:true,time:{minSeconds:60,maxSeconds:120},recommended:true}]})};
      if(at.pathname.endsWith('/start'))return {ok:true,json:async()=>({job:job({})})};
      if(at.pathname.endsWith('/dismiss'))return {ok:false,status:dismissStatus,json:async()=>({error:dismissStatus===404?'コピーの作業が見つかりません':'コピーの作業が終わってから閉じてください'})};
    }
    return {ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const open=()=>{const view=render(<NativeWorkspace projectId="linked"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));fireEvent.click(view.getByRole('tab',{name:'BGM 2'}));return view;};

it('copies a linked file from its row: choose the place, start, and the dialog closes',async()=>{
  const view=open();
  fireEvent.click(await view.findByRole('button',{name:'SD1.wavを速いドライブへコピー'}));
  const dialog=await view.findByRole('dialog',{name:'コピー先を選ぶ'});
  await within(dialog).findByText('おすすめ');expect(requests[0]).toEqual({route:'/media-copy/destinations',body:{assetIds:['r1']}});
  fireEvent.click(within(dialog).getByRole('button',{name:'コピーを始める'}));
  await waitFor(()=>expect(view.queryByRole('dialog',{name:'コピー先を選ぶ'})).toBeNull());
  expect(requests[1]).toEqual({route:'/media-copy/start',body:{assetIds:['r1'],destination:{key:'internal',uuid:'BOOT',dev:1}}});
});
it('shows the progress and keeps the row from starting another copy while this editor copies it; a job run elsewhere does not',async()=>{
  jobs=[job({}),job({jobId:'cp-11111111111111111111',notThisProcess:true,items:[{itemId:'c0',name:'SD2.wav',sizeBytes:GiB,phase:'copying',bytesDone:0,assetId:'r2'}]})];states.r1='copying';states.r2='copying';
  const view=open();
  await waitFor(()=>expect((view.getByRole('button',{name:'SD1.wavを速いドライブへコピー'}) as HTMLButtonElement).disabled).toBe(true));
  expect(view.getByRole('button',{name:'SD1.wavを速いドライブへコピー'}).textContent).toBe('コピー中');
  expect((view.getByRole('button',{name:'SD2.wavを速いドライブへコピー'}) as HTMLButtonElement).disabled).toBe(false);
  expect(view.container.querySelector('[data-copy-job="cp-00000000000000000000"][data-state="running"]')).not.toBeNull();
  expect(view.getAllByRole('button',{name:'残りを中止'})).toHaveLength(1);
  await waitFor(()=>expect(view.getAllByText('コピー中')).toHaveLength(2));   // 自分の作業は行のボタン、別のエディターの作業は状態確認の「コピー中」
  expect(view.container.querySelector('.native-reference-notice')).toBeNull();   // コピー中は接続の問題ではない
});
it('shows why a finished job could not be closed, and lets it be pressed again',async()=>{
  jobs=[job({state:'finished',items:[{itemId:'c0',name:'SD1.wav',sizeBytes:GiB,phase:'done',bytesDone:GiB,assetId:'r1'}]})];
  const view=open();
  fireEvent.click(await view.findByRole('button',{name:'閉じる'}));
  expect(await view.findByText('コピーの作業が終わってから閉じてください')).toBeTruthy();
  await waitFor(()=>expect((view.getByRole('button',{name:'閉じる'}) as HTMLButtonElement).disabled).toBe(false));
});
// 閉じるの二度押し・他の画面で閉じた後: 見つからない（404）は閉じられたものとして扱う（理由を出さず、押せないまま一覧の更新を待つ）。
it('takes a job that is already gone as closed',async()=>{
  dismissStatus=404;jobs=[job({state:'finished',items:[{itemId:'c0',name:'SD1.wav',sizeBytes:GiB,phase:'done',bytesDone:GiB,assetId:'r1'}]})];
  const view=open();
  fireEvent.click(await view.findByRole('button',{name:'閉じる'}));
  await waitFor(()=>expect(requests.some(request=>request.route==='/media-copy/dismiss')).toBe(true));await act(async()=>{});
  expect(view.queryByText('コピーの作業が見つかりません')).toBeNull();expect((view.getByRole('button',{name:'閉じる'}) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps the row from starting a copy while editing is locked',async()=>{
  h.busy=true;const view=open();
  expect((await view.findByRole('button',{name:'SD1.wavを速いドライブへコピー'}) as HTMLButtonElement).disabled).toBe(true);
});
// 素材の読み直し（プレビュー・タイムラインの作り直し）は作業の終わりにまとめて1回、再生中なら止まってから。終わった作業は通知でも知らせる。
it('reloads the media once when the job ends, after playback stops, and tells that the copy finished',async()=>{
  const view=open();await waitFor(()=>expect(h.bus).not.toBeNull());await waitFor(()=>expect(h.mounts).toBe(1));
  const send=(phases:Array<CopyJobView['items'][number]['phase']>,state:CopyJobView['state']='running')=>act(()=>{h.bus!({type:'list',jobs:[job({state,
    items:phases.map((phase,index)=>({itemId:`c${index}`,name:`SD${index+1}.wav`,sizeBytes:GiB,phase,bytesDone:0,assetId:`r${index+1}`}))})]});});
  send(['copying','waiting']);send(['done','copying']);expect(h.mounts).toBe(1);   // 1本終わっても作り直さない
  act(()=>h.playback!(true));send(['done','done'],'finished');
  expect(await view.findByText('速いドライブへのコピーが終わりました（2 本）。素材はコピー先を使います')).toBeTruthy();
  expect(h.mounts).toBe(1);   // 再生中は待つ
  act(()=>h.playback!(false));await waitFor(()=>expect(h.mounts).toBe(2));
  send(['done','done'],'finished');await act(async()=>{});expect(h.mounts).toBe(2);
});
