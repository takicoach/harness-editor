/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

/**
 * I'-2: ツールバーの退避（表示群 → 「表示」ポップオーバー）の再測定が ResizeObserver＝箱の変化だけだと、
 * 箱は同じで中身だけが増える状態変化（仕上げの「選択範囲を戻す」が現れる）では一度も測り直されない。
 * その状態は「非退避かつ溢れている」ままで、右端の表示群が overflow:hidden に切られて到達不能になる。
 * 中身を決める state（ここでは cutRestoreSelected）で再測定が走ることを固定する。
 */
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props:any,ref)=>{
  useImperativeHandle(ref,()=>({pause:()=>{},flushManipulation:async()=>true}));return null;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props:any,ref)=>{
  useImperativeHandle(ref,()=>({blurDraft:()=>{},flush:async()=>true}));return null;
})}));
// 「選択範囲を戻す」の出入りは本物のタイムライン（カット行）が決める。ここでは同じ通知だけを出す。
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef(({onRestoreSelection}:any,ref)=>{
  // I-1: NativeTimelineHandle（NativeTimeline.tsx:75）と同形にする。
  useImperativeHandle(ref,()=>({flush:async()=>true,restoreCut:async()=>true,fitZoom:()=>{}}));
  return <button type="button" onClick={()=>onRestoreSelection?.(true)}>カットを選んだことにする</button>;
})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useCutSourcePreview',()=>({useCutSourcePreview:()=>({active:null,owners:[],clipId:'',pending:false,
  choose:()=>{},open:async()=>{},stop:()=>{},seekProgram:()=>{},onFrame:()=>{},marker:undefined})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'toolbar-remeasure',revision:0,name:'toolbar-remeasure',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:90,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false})}));

beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{
    constructor(private readonly callback:ResizeObserverCallback){}
    observe(){this.callback([{contentRect:{width:1400,height:900}} as ResizeObserverEntry],this as unknown as ResizeObserver);}
    disconnect(){}unobserve(){}
  });
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear();});

it('中身が増えて溢れたら、箱の変化が無くても退避する（表示群が「表示」へ入る）',()=>{
  const view=render(<NativeWorkspace projectId="toolbar-remeasure"/>);
  const toolbar=view.container.querySelector('.native-timeline-toolbar');
  expect(toolbar).toBeTruthy();                                   // 存在検査（ツールバーが無ければ以下は何も言っていない）
  // jsdom は寸法を持たないので実測値を与える。ここでは「必要 1256 / 容器 1100 = 溢れ」。
  Object.defineProperty(toolbar!,'scrollWidth',{configurable:true,value:1256});
  Object.defineProperty(toolbar!,'clientWidth',{configurable:true,value:1100});
  expect(view.queryByRole('button',{name:'表示'})).toBeNull();    // 前提: まだ測り直していないので退避していない
  fireEvent.click(view.getByRole('button',{name:'カットを選んだことにする'}));
  expect(view.queryByRole('button',{name:'表示'})).not.toBeNull();
});

/**
 * M-10: 実際にこの経路が壊れる場面＝仕上げモードで「選択範囲を戻す」が現れるときを丸ごと再現する。
 * 「中身の変化 → 測定 → 退避」の 3 段を 1 件で通し、中身が増えたこと自体（ボタンの出現）も見る。
 * 編集モードの 1 件目は「箱が変わらなくても測り直す」ことだけを見ており、モードの条件を含まない。
 */
it('仕上げモード: カットを選ぶと「選択範囲を戻す」が増え、測り直して表示群が退避する',()=>{
  sessionStorage.setItem('harness-native-view:toolbar-remeasure-finish',JSON.stringify({mode:'finish',tab:'video'}));
  const view=render(<NativeWorkspace projectId="toolbar-remeasure-finish"/>);
  expect(view.getByRole('button',{name:'カットの詳細'})).toBeTruthy();   // 存在検査: 仕上げモードで描けている
  const toolbar=view.container.querySelector('.native-timeline-toolbar');
  expect(toolbar).toBeTruthy();
  Object.defineProperty(toolbar!,'scrollWidth',{configurable:true,value:1256});
  Object.defineProperty(toolbar!,'clientWidth',{configurable:true,value:1100});
  expect(view.queryByRole('button',{name:'選択範囲を戻す'})).toBeNull();
  expect(view.queryByRole('button',{name:'表示'})).toBeNull();
  fireEvent.click(view.getByRole('button',{name:'カットを選んだことにする'}));
  expect(view.queryByRole('button',{name:'選択範囲を戻す'})).not.toBeNull();   // 中身が増えた
  expect(view.queryByRole('button',{name:'表示'})).not.toBeNull();             // 測り直して退避した
});
