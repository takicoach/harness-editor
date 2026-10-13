/** @vitest-environment jsdom */
import {forwardRef,useEffect,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import {applySequenceCommand} from '../../core/sequence/commands';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

/** 部品は props を覗けるだけの殻にし、NativeWorkspace の結合（試しの開始・表示・停止・終了）だけを観測する。 */
const h=vi.hoisted(()=>({
  session:null as any,setSession:null as null|((next:any)=>void),frame:0,flushOk:true,mounts:0,busy:false,flush:null as any,documents:[] as any[],
  preview:null as any,inspector:null as any,timeline:null as any,exportProps:null as any,autoSave:null as any,bridge:null as any,
  pause:vi.fn(),cutStop:vi.fn(),executeAt:vi.fn(),execute:vi.fn(async()=>true),save:vi.fn(async()=>true),request:vi.fn(),refreshStatus:vi.fn(),
}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:any,ref)=>{
  h.preview=props;if(h.documents.at(-1)!==props.document)h.documents.push(props.document);useEffect(()=>{h.mounts++;},[]);
  useImperativeHandle(ref,()=>({pause:h.pause,frame:()=>h.frame,seek:async()=>{},seekBy:()=>{},toggle:()=>{},flushManipulation:async()=>true,cancelManipulation:()=>{}}));
  return <div data-testid="preview">{props.monitorControls}</div>;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((props:any,ref)=>{
  h.inspector=props;useImperativeHandle(ref,()=>({blurDraft:()=>{},flush:()=>h.flush()}));return null;
})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:(props:any)=>{h.timeline=props;return null;}}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:(props:any)=>{h.exportProps=props;return null;}}));
vi.mock('./NativeCaptionPanel',()=>({NativeCaptionPanel:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeCutPanel',()=>({NativeCutPanel:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:(params:any)=>{h.autoSave=params;}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
// AI 編集の受け取り判定は本物（useNativeEditorBridge）を通す。接続だけを止め、作られた bridge を受け取る。
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:(bridge:any)=>{h.bridge=bridge;return {connection:'disconnected'};}}));
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),nativeRequest:h.request}));
vi.mock('./useCutSourcePreview',()=>({useCutSourcePreview:()=>({active:null,owners:[],clipId:'',pending:false,
  choose:()=>{},open:async()=>{},stop:h.cutStop,seekProgram:()=>{},onFrame:()=>{},marker:undefined})}));
vi.mock('./useNativeSession',async()=>{
  const {useState}=await import('react');
  return {useNativeSession:()=>{
    const [state,setState]=useState(()=>h.session);
    h.setSession=next=>{h.session=next;setState(next);};
    return {state,loading:false,busy:h.busy,error:null,saveProgress:null,clearError:()=>{},readCurrent:()=>h.session,
      accept:(next:any)=>h.setSession!(next),execute:h.execute,executeAt:h.executeAt,save:h.save,refreshStatus:h.refreshStatus};
  }};
});

const layout={position:{x:0,y:0},scale:1,rotation:0,flipH:false,flipV:false,background:'transparent'} as const;
const clock=(n:number)=>({offset:r(0),rate:r(1),duration:r(n)});
const settings={gainDb:-12,muted:false,fadeInFrames:0,fadeOutFrames:0};
function baseDoc():SequenceDocument{
  return {schemaVersion:2,id:'trial',name:'trial',revision:3,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',
    tracks:[{id:'v',name:'挿入',kind:'visual',enabled:true},{id:'a',name:'原音',kind:'audio',enabled:true},{id:'m',name:'音楽',kind:'audio',enabled:true}],
    assets:[
      {id:'img-a',kind:'image',file:'public/images/a.png',name:'図A',fingerprint:'a'.repeat(64),streams:[]},
      {id:'img-b',kind:'image',file:'public/images/b.png',name:'図B',fingerprint:'b'.repeat(64),streams:[]},
      {id:'img-c',kind:'image',file:'public/images/c.png',name:'図C',fingerprint:'c'.repeat(64),streams:[]},
      {id:'voice',kind:'media',file:'public/voice.wav',name:'声',fingerprint:'d'.repeat(64),streams:[{index:0,kind:'audio',codec:'pcm_s16le',sampleRate:48000,channels:2,duration:r(6)}]},
      {id:'song-a',kind:'media',file:'public/BGM/a.m4a',name:'曲A',fingerprint:'e'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',sampleRate:48000,channels:2,duration:r(10)}]},
      {id:'song-short',kind:'media',file:'public/BGM/s.m4a',name:'短い曲',fingerprint:'f'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',sampleRate:48000,channels:2,duration:r(2)}]}],
    clips:[
      {id:'pic',name:'図',trackId:'v',startFrame:60,durationFrames:60,clock:clock(60),content:{kind:'image',assetId:'img-a',style:'plain'},visual:{layout:structuredClone(layout),opacity:1,keyframes:[]}},
      {id:'speech',name:'声',trackId:'a',startFrame:0,durationFrames:180,clock:clock(180),content:{kind:'audio',assetId:'voice',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings}},
      {id:'bgm',name:'BGM',trackId:'m',startFrame:0,durationFrames:180,clock:clock(180),content:{kind:'audio',assetId:'song-a',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings}}],
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
}
const sessionOf=(document:SequenceDocument)=>({sessionId:'s',dirty:false,canUndo:true,canRedo:false,savedRevision:document.revision,document});
function setup(document=baseDoc(),view:Record<string,unknown>={mode:'edit',selected:['pic']}){
  h.session=sessionOf(document);sessionStorage.setItem('harness-native-view:trial',JSON.stringify(view));
  return render(<NativeWorkspace projectId="trial"/>);
}
/** 試しを始め、プレビューに新しい世代の試し用文書が届くまで待つ。世代はワークスペースを開いている間増え続ける。 */
const start=async(assetId='img-b',clipId='pic')=>{
  const before=h.preview.document.id;
  await act(async()=>{h.inspector.trialSwap.onStart(assetId);});
  await waitFor(()=>{expect(h.preview.document.id).toMatch(new RegExp(`^${h.session.document.id}:trial:\\d+$`));expect(h.preview.document.id).not.toBe(before);});
  expect(h.inspector.selected[0]).toBe(clipId);
  return h.preview.document.id as string;
};
const AUTO_END='内容が更新されたため試し表示を終了しました',LOCKED='試し表示中は編集できません。採用するか戻してから操作してください';

beforeEach(()=>{
  sessionStorage.clear();h.frame=0;h.flushOk=true;h.busy=false;h.flush=async()=>h.flushOk;h.documents=[];
  for(const fn of [h.pause,h.cutStop,h.executeAt,h.execute,h.save,h.request,h.refreshStatus])fn.mockReset();
  h.execute.mockResolvedValue(true);h.save.mockResolvedValue(true);
  h.request.mockImplementation(async(_project:string,route:string)=>{
    if(route==='/agent'){const document={...h.session.document,revision:h.session.document.revision+1};return {...sessionOf(document),appliedRevision:document.revision};}
    return {status:'unchanged'};
  });
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('開始すると他の確認表示が消え、使用箇所の外にいれば先頭へ移ってプレビューに試し用文書が渡る',async()=>{
  // 仕上げモードでカット込み確認と設定欄の見た目プレビューを出しておく。
  const doc=applySequenceCommand(baseDoc(),{type:'ripple-delete',startFrame:150,endFrame:170});
  const v=setup(doc,{mode:'finish',selected:['pic']});
  const inclusive=v.getByLabelText('カット区間も再生') as HTMLInputElement;
  await act(async()=>{fireEvent.click(inclusive);});
  await waitFor(()=>expect(h.preview.document.id).toBe('cut-inclusive-preview'));
  act(()=>h.inspector.onPreviewVisual('pic',{layout:{...structuredClone(layout),scale:2},opacity:1,keyframes:[]}));
  h.pause.mockClear();h.cutStop.mockClear();const mounts=h.mounts;
  await start();
  expect(h.cutStop).toHaveBeenCalled();expect(h.pause).toHaveBeenCalled();
  expect(inclusive.checked).toBe(false);expect(h.preview.visualPreview).toBeNull();
  expect(h.preview.initialFrame).toBe(60); // 再生位置 0 は「図」（60〜119）の外
  expect(h.mounts).toBe(mounts); // key は変えない（プレビューを作り直さない）
  expect(v.getByText('試し表示中：図B。保存されていません')).toBeTruthy();
  // 戻すと元の文書へ。カット込み確認と見た目プレビューは戻らない（開始時に終わらせている）。
  h.pause.mockClear();h.frame=70;
  fireEvent.click(v.getByRole('button',{name:'戻す'}));
  await waitFor(()=>expect(h.preview.document).toBe(h.session.document));
  expect(h.pause).toHaveBeenCalled();expect(h.preview.initialFrame).toBe(70);
  expect(inclusive.checked).toBe(false);expect(h.preview.visualPreview).toBeNull();
  expect(v.queryByText(/試し表示中/)).toBeNull();expect(h.mounts).toBe(mounts);
});

it('入力を確定できない間とドラッグ中は開始しない',async()=>{
  const v=setup();
  h.flushOk=false;
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');});
  expect(h.preview.document).toBe(h.session.document);expect(v.queryByText(/試し表示中/)).toBeNull();
  h.flushOk=true;
  act(()=>h.preview.manipulation.onBusy(true));
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');});
  await waitFor(()=>expect(v.getByText('操作が終わってから試してください')).toBeTruthy());
  expect(h.preview.document).toBe(h.session.document);expect(v.queryByText(/試し表示中/)).toBeNull();
});

it('候補と終わり方の切替で世代が進み、毎回一時停止してプレイヤーの実際の位置を渡す',async()=>{
  setup(baseDoc(),{mode:'edit',selected:['bgm']});
  h.frame=75;
  await start('song-short','bgm');
  expect(h.preview.initialFrame).toBe(75); // 使用箇所の中なので動かさない
  h.frame=90;h.pause.mockClear();
  act(()=>h.inspector.trialSwap.onEndMode('silence'));
  expect(h.preview.document.id).toBe('trial:trial:2');expect(h.preview.initialFrame).toBe(90);expect(h.pause).toHaveBeenCalled();
  expect(h.preview.document.clips.find((c:any)=>c.id==='bgm').content.endBehavior).toBe('silence');
  h.frame=100;h.pause.mockClear();
  act(()=>h.inspector.trialSwap.onChoose('song-a'));
  expect(h.preview.document.id).toBe('trial:trial:3');expect(h.preview.initialFrame).toBe(100);expect(h.pause).toHaveBeenCalled();
});

it('採用は開始時の版で executeAt を1回だけ呼び、採用中は採用・戻す・候補の切替を受け付けない',async()=>{
  let finish:(value:string)=>void=()=>{};
  h.executeAt.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const v=setup();
  await start();
  h.frame=80;h.pause.mockClear();
  const adopt=v.getByRole('button',{name:'採用'}) as HTMLButtonElement;
  fireEvent.click(adopt);fireEvent.click(adopt);
  expect(h.pause).toHaveBeenCalled();
  expect(h.executeAt).toHaveBeenCalledTimes(1);
  expect(h.executeAt.mock.calls[0]![1]).toEqual({sessionId:'s',revision:3});
  expect(JSON.stringify(h.executeAt.mock.calls[0]![0])).toContain('"assetId":"img-b"');
  expect(adopt.disabled).toBe(true);expect((v.getByRole('button',{name:'戻す'}) as HTMLButtonElement).disabled).toBe(true);
  expect(h.inspector.trialSwap.trial.adopting).toBe(true);
  act(()=>h.inspector.trialSwap.onChoose('img-c'));
  expect(h.preview.document.id).toBe('trial:trial:1');
  // サーバが受け付けて版が進む → 採用の完了。自動解除の知らせは出さない。
  const adopted={...h.session.document,revision:4};
  await act(async()=>{h.setSession!(sessionOf(adopted));finish('ok');});
  await waitFor(()=>expect(h.preview.document).toBe(adopted));
  expect(v.queryByText(/試し表示中/)).toBeNull();expect(v.queryByText(AUTO_END)).toBeNull();
  expect(h.executeAt).toHaveBeenCalledTimes(1);
});

it('試し中は編集と書き出しを止め、保存と自動保存は止めない',async()=>{
  const v=setup();
  const undo=v.getByRole('button',{name:'元に戻す'}) as HTMLButtonElement;
  expect(undo.disabled).toBe(false);expect(h.exportProps.disabledReason).toBeUndefined();expect(h.preview.manipulation).toBeTruthy();
  await start();
  expect(h.exportProps.disabledReason).toBe('試し表示中は書き出せません');
  expect(h.timeline.busy).toBe(false);expect(h.timeline.editLocked).toBe(true); // 再生位置の移動・スクラブは通し、クリップの編集だけ止める
  expect(h.inspector.disabled).toBe(true);
  expect(h.inspector.trialSwap.disabled).toBe(false); // 節は押し直せる
  expect(undo.disabled).toBe(true);expect(h.preview.manipulation).toBeUndefined();
  expect(h.autoSave.saveStatus).toBe('idle');
  // 編集ショートカットは効かず、保存だけ通る。
  fireEvent.keyDown(document.body,{key:'Delete'});
  await act(async()=>{});expect(h.execute).not.toHaveBeenCalled();
  const save=v.getByRole('button',{name:'保存'}) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.click(save);await waitFor(()=>expect(h.save).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(document.body,{key:'s',metaKey:true});await waitFor(()=>expect(h.save).toHaveBeenCalledTimes(2));
  expect(v.getByText(/試し表示中：/)).toBeTruthy();
});

it('タイムラインには使用箇所の印を渡す',async()=>{
  setup();
  expect(h.timeline.trialClipIds??[]).toEqual([]);
  await start();
  expect(h.timeline.trialClipIds).toEqual(['pic']);
});

it('AI 編集は試し中も受け取られ、版が進むと自動で解除して知らせる',async()=>{
  const v=setup();
  await start();
  const presence=h.bridge.presence('trial');
  expect(presence.humanBusy).toBe(false);expect(presence.saving).toBe(false);
  const change={schemaVersion:1,projectId:'trial',operationId:'op-1',baseRevision:presence.revision,
    changes:[{type:'set_telop_text',elementId:'x',before:'a',after:'b',sourceFrameRange:{start:0,end:1}}]};
  let result:any;
  await act(async()=>{result=await h.bridge.apply(change,{runId:'run',token:'token'});});
  expect(result.phase).toBe('applied');
  expect(h.request.mock.calls.some(call=>call[1]==='/agent')).toBe(true);
  await waitFor(()=>expect(v.getByText(AUTO_END)).toBeTruthy());
  expect(h.preview.document).toBe(h.session.document);expect(h.session.document.revision).toBe(4);
  expect(v.queryByText(/試し表示中/)).toBeNull();
});

it.each([
  ['使用箇所の外のクリップを選ぶ',(_v:ReturnType<typeof render>)=>h.timeline.onSelect(['speech'])],
  ['設定欄の別タブへ移る',(v:ReturnType<typeof render>)=>fireEvent.click(v.getByRole('tab',{name:'字幕一覧'}))],
  ['編集モードを切り替える',(v:ReturnType<typeof render>)=>fireEvent.click(v.getByRole('button',{name:'仕上げ'}))],
])('%sと試しが終わる',async(_label,leave)=>{
  const v=setup();
  await start();
  await act(async()=>{leave(v);});
  await waitFor(()=>expect(h.preview.document).toBe(h.session.document));
  expect(v.queryByText(/試し表示中/)).toBeNull();expect(h.inspector.trialSwap.trial).toBeNull();
  expect(v.queryByText(AUTO_END)).toBeNull();
});

it('選択が空になるだけでは試しは終わらない。再生位置を動かしても続き、帯の採用・戻すが働く',async()=>{
  h.executeAt.mockResolvedValue('ok');
  const v=setup();
  await start();
  // タイムラインの空き部分のクリック（選択を外して再生位置を動かす）と Escape。
  await act(async()=>{h.timeline.onSelect([]);});
  await waitFor(()=>expect(h.inspector.selected).toEqual([]));
  await act(async()=>{h.timeline.onSeek(150);fireEvent.keyDown(document.body,{key:'Escape'});});
  expect(v.getByText('試し表示中：図B。保存されていません')).toBeTruthy();
  expect(h.inspector.trialSwap.trial).not.toBeNull();expect(h.preview.document.id).toBe('trial:trial:1');expect(h.timeline.trialClipIds).toEqual(['pic']);
  expect(v.queryByText(AUTO_END)).toBeNull();
  // 戻すが働く。
  fireEvent.click(v.getByRole('button',{name:'戻す'}));
  await waitFor(()=>expect(h.preview.document).toBe(h.session.document));
  expect(v.queryByText(/試し表示中/)).toBeNull();
  // 採用も働く（選び直して始め、選択を外してから採用）。
  await act(async()=>{h.timeline.onSelect(['pic']);});
  await waitFor(()=>expect(h.inspector.selected).toEqual(['pic']));
  await start();
  await act(async()=>{h.timeline.onSelect([]);});
  await waitFor(()=>expect(h.inspector.selected).toEqual([]));
  fireEvent.click(v.getByRole('button',{name:'採用'}));
  await waitFor(()=>expect(h.executeAt).toHaveBeenCalledTimes(1));
  expect(h.executeAt.mock.calls[0]![1]).toEqual({sessionId:'s',revision:3});expect(JSON.stringify(h.executeAt.mock.calls[0]![0])).toContain('"assetId":"img-b"');
});

it('プレビューが候補を読み込めない間は採用できず、候補を切り替えると採用できる',async()=>{
  const v=setup();
  await start();
  act(()=>h.preview.onError({message:'読み込めません'}));
  expect((v.getByRole('button',{name:'採用'}) as HTMLButtonElement).disabled).toBe(true);
  expect((v.getByRole('button',{name:'戻す'}) as HTMLButtonElement).disabled).toBe(false);
  act(()=>h.inspector.trialSwap.onChoose('img-c'));
  expect((v.getByRole('button',{name:'採用'}) as HTMLButtonElement).disabled).toBe(false);
  // 戻してから始め直しても、前の失敗は持ち越さない。
  act(()=>h.preview.onError({message:'読み込めません'}));
  fireEvent.click(v.getByRole('button',{name:'戻す'}));
  await start();
  expect((v.getByRole('button',{name:'採用'}) as HTMLButtonElement).disabled).toBe(false);
});

it('同じ使用箇所の別のクリップを選んで候補を押すと、始め直さずに候補の切替として世代が進む',async()=>{
  const doc=baseDoc(),first=doc.clips.find(c=>c.id==='bgm')!;
  first.durationFrames=90;first.clock=clock(90);first.continuationGroupId='g';
  doc.assets.push({id:'song-b',kind:'media',file:'public/BGM/b.m4a',name:'曲B',fingerprint:'9'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',sampleRate:48000,channels:2,duration:r(10)}]});
  doc.clips.push({...structuredClone(first),id:'bgm-2',startFrame:120,durationFrames:60,clock:clock(60),content:{...structuredClone(first.content),sourceIn:r(4)} as never});
  h.executeAt.mockResolvedValue('ok');
  const v=setup(doc,{mode:'edit',selected:['bgm']});
  await start('song-short','bgm');
  expect(h.timeline.trialClipIds).toEqual(['bgm','bgm-2']);
  await act(async()=>{h.timeline.onSelect(['bgm-2']);});
  await waitFor(()=>expect(h.inspector.selected).toEqual(['bgm-2']));
  expect(v.getByText('試し表示中：短い曲。保存されていません')).toBeTruthy(); // 同じ使用箇所なので試しは続く
  await act(async()=>{h.inspector.trialSwap.onStart('song-b');});
  expect(h.preview.document.id).toBe('trial:trial:2');
  expect(v.getByText('試し表示中：曲B。保存されていません')).toBeTruthy();
  fireEvent.click(v.getByRole('button',{name:'採用'}));
  await waitFor(()=>expect(h.executeAt).toHaveBeenCalledTimes(1));
  const sent=JSON.stringify(h.executeAt.mock.calls[0]![0]);
  expect(sent).toContain('"assetId":"song-b"');expect(sent).not.toContain('"assetId":"song-short"');
});

it('採用の結果が分からないときは、状態を読み直してから確かめるよう知らせる',async()=>{
  h.executeAt.mockResolvedValue('unknown');
  const v=setup();
  await start();
  const adopted={...h.session.document,revision:4};
  h.refreshStatus.mockImplementation(async()=>{h.setSession!(sessionOf(adopted));});
  fireEvent.click(v.getByRole('button',{name:'採用'}));
  await waitFor(()=>expect(v.getByText('採用できたか確認できませんでした。タイムラインを確かめてください')).toBeTruthy());
  expect(h.refreshStatus).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(h.preview.document).toBe(adopted)); // サーバで採用済みなら、その版が画面に出る
});

it('節の無効は、試し中は採用中だけ。試し中でなければ処理中（保存など）で無効',async()=>{
  setup();
  h.busy=true;act(()=>h.setSession!({...h.session}));
  expect(h.inspector.trialSwap.disabled).toBe(true);
  h.busy=false;act(()=>h.setSession!({...h.session}));
  await start();
  h.busy=true;act(()=>h.setSession!({...h.session})); // 試し中に自動保存が走っても候補は押せる
  expect(h.inspector.trialSwap.disabled).toBe(false);
});

it('試し中も工具・スナップのキーは通し、編集のキー・詰める・ドロップ・タイムラインの編集は止めて知らせる',async()=>{
  const v=setup();
  await start();
  const ripple=v.getByRole('button',{name:'詰める'}) as HTMLButtonElement;
  expect(ripple.disabled).toBe(true);
  fireEvent.keyDown(document.body,{key:'c'});expect(h.timeline.tool).toBe('razor');
  const snap=h.timeline.snap;fireEvent.keyDown(document.body,{key:'s'});expect(h.timeline.snap).toBe(!snap);
  const before=ripple.getAttribute('aria-pressed');
  fireEvent.keyDown(document.body,{key:'r'});
  expect(ripple.getAttribute('aria-pressed')).toBe(before);
  await waitFor(()=>expect(v.getByText(LOCKED)).toBeTruthy());
  for(const key of [{key:'Delete'},{key:'z',metaKey:true},{key:'k',metaKey:true}]){
    act(()=>{fireEvent.click(v.getByRole('button',{name:'通知を閉じる'}));});
    expect(v.queryByText(LOCKED)).toBeNull();
    fireEvent.keyDown(document.body,key);
    await waitFor(()=>expect(v.getByText(LOCKED)).toBeTruthy());
  }
  for(const attempt of [()=>h.timeline.onEditLocked(),()=>h.timeline.onDrop('img-c',10,'v')]){
    act(()=>{fireEvent.click(v.getByRole('button',{name:'通知を閉じる'}));});
    act(()=>{attempt();});
    await waitFor(()=>expect(v.getByText(LOCKED)).toBeTruthy());
  }
  await act(async()=>{});
  expect(h.execute).not.toHaveBeenCalled();expect(v.getByText(/試し表示中：/)).toBeTruthy();
});

it('複数選択に使用箇所の外のクリップがあれば、候補を押しても何も起きない（一時停止・確認表示の終了・移動なし）',async()=>{
  const doc=applySequenceCommand(baseDoc(),{type:'ripple-delete',startFrame:150,endFrame:170});
  const v=setup(doc,{mode:'finish',selected:['pic','speech']});
  const inclusive=v.getByLabelText('カット区間も再生') as HTMLInputElement;
  await act(async()=>{fireEvent.click(inclusive);});
  await waitFor(()=>expect(h.preview.document.id).toBe('cut-inclusive-preview'));
  h.pause.mockClear();h.cutStop.mockClear();const frame=h.preview.initialFrame;
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');});
  await act(async()=>{});
  expect(h.pause).not.toHaveBeenCalled();expect(h.cutStop).not.toHaveBeenCalled();
  expect(inclusive.checked).toBe(true);expect(h.preview.document.id).toBe('cut-inclusive-preview');expect(h.preview.initialFrame).toBe(frame);
  expect(h.inspector.trialSwap.trial).toBeNull();expect(v.queryByText(/試し表示中/)).toBeNull();expect(h.documents.some((d:any)=>/:trial:/.test(d.id))).toBe(false);
});

it('同じ使用箇所の複数片を選んでいれば試せて、その選択のまま試しが続く',async()=>{
  const doc=baseDoc(),first=doc.clips.find(c=>c.id==='bgm')!;
  first.durationFrames=90;first.clock=clock(90);first.continuationGroupId='g';
  doc.clips.push({...structuredClone(first),id:'bgm-2',startFrame:120,durationFrames:60,clock:clock(60),content:{...structuredClone(first.content),sourceIn:r(4)} as never});
  const v=setup(doc,{mode:'edit',selected:['bgm','bgm-2']});
  await start('song-short','bgm');
  await act(async()=>{});
  expect(h.inspector.trialSwap.trial).not.toBeNull();expect(h.timeline.trialClipIds).toEqual(['bgm','bgm-2']);
  expect(v.getByText('試し表示中：短い曲。保存されていません')).toBeTruthy();
});

it('理由はクリップに結び付き、選択が変わると消える（BGM の理由を画像の節に渡さない）',async()=>{
  setup(baseDoc(),{mode:'edit',selected:['bgm']});
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');}); // 画像は BGM の候補にできない
  await waitFor(()=>expect(h.inspector.trialSwap.error).toEqual({clipId:'bgm',message:'この素材はこのクリップの候補にできません'}));
  expect(h.inspector.trialSwap.trial).toBeNull();
  await act(async()=>{h.timeline.onSelect(['pic']);});
  await waitFor(()=>expect(h.inspector.selected).toEqual(['pic']));
  expect(h.inspector.trialSwap.error).toBeNull();
});

it('開始の処理中にもう一度押すと、2本目は始めず「操作が終わってから試してください」と知らせる（設計 §5）',async()=>{
  const v=setup();
  const gates:Array<(ok:boolean)=>void>=[];
  h.flush=()=>new Promise<boolean>(resolve=>{gates.push(resolve);});
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');});
  const waiting=gates.length;expect(waiting).toBeGreaterThan(0);expect(v.queryByText('操作が終わってから試してください')).toBeNull();
  await act(async()=>{h.inspector.trialSwap.onStart('img-c');});
  await waitFor(()=>expect(v.getByText('操作が終わってから試してください')).toBeTruthy());
  expect(gates).toHaveLength(waiting); // 2本目は入力の確定にも進まない
  h.flush=async()=>h.flushOk;
  for(const gate of gates)await act(async()=>{gate(true);});
  await waitFor(()=>expect(h.preview.document.id).toMatch(/^trial:trial:\d+$/));
  expect(h.preview.document.clips.find((c:any)=>c.id==='pic').content.assetId).toBe('img-b');
});
it('開始が2本並んでも、同じ id で別の内容がプレビューに渡らず、表示と採用の内容が一致する',async()=>{
  h.executeAt.mockResolvedValue('ok');
  const v=setup();
  // 1本目の入力確定を止めている間に2本目を押す。2本目の確定が先に終わっても、1本目と同じ id の別内容を作らない。
  const gates:Array<(ok:boolean)=>void>=[];
  h.flush=()=>new Promise<boolean>(resolve=>{gates.push(resolve);});
  await act(async()=>{h.inspector.trialSwap.onStart('img-b');h.inspector.trialSwap.onStart('img-c');});
  h.flush=async()=>h.flushOk;
  for(const gate of [...gates].reverse())await act(async()=>{gate(true);});
  await waitFor(()=>expect(h.preview.document.id).toMatch(/^trial:trial:\d+$/));
  const seen=new Map<string,string>();
  for(const d of h.documents){const key=`${d.id}@${d.revision}`,body=JSON.stringify(d);expect(seen.get(key)??body).toBe(body);seen.set(key,body);}
  const shown=h.preview.document.clips.find((c:any)=>c.id==='pic').content.assetId,name=shown==='img-b'?'図B':'図C';
  expect(h.inspector.trialSwap.trial.result.preview).toBe(h.preview.document);
  expect(v.getByText(`試し表示中：${name}。保存されていません`)).toBeTruthy();
  // 次の候補は前と違う id でプレビューに届く。
  const previous=h.preview.document.id,next=shown==='img-b'?'img-c':'img-b';
  act(()=>h.inspector.trialSwap.onChoose(next));
  expect(h.preview.document.id).not.toBe(previous);expect(h.preview.document.clips.find((c:any)=>c.id==='pic').content.assetId).toBe(next);
  fireEvent.click(v.getByRole('button',{name:'採用'}));
  await waitFor(()=>expect(h.executeAt).toHaveBeenCalledTimes(1));
  expect(JSON.stringify(h.executeAt.mock.calls[0]![0])).toContain(`"assetId":"${next}"`);
});

it('試し中は、編集操作の共通入口が古い描画から呼ばれても送らずに知らせる',async()=>{
  const v=setup();
  const stale=h.inspector.onCommand; // 試しを始める前の描画のもの
  await start();
  let ok=true;
  await act(async()=>{ok=await stale({type:'update-clip',clipId:'pic',patch:{name:'変えた'}});});
  expect(ok).toBe(false);expect(h.execute).not.toHaveBeenCalled();
  await waitFor(()=>expect(v.getByText(LOCKED)).toBeTruthy());
  expect(v.getByText('試し表示中：図B。保存されていません')).toBeTruthy();
  await act(async()=>{ok=await h.inspector.onCommand({type:'update-clip',clipId:'pic',patch:{name:'変えた'}});});
  expect(ok).toBe(false);expect(h.execute).not.toHaveBeenCalled();
});
