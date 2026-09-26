/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

/**
 * I-5: 1200px 未満では `leftHidden=false` だけでは左カラムは開かない（`narrow && !leftPinned` で
 * 畳まれたまま）。推奨窓 1280×800 はこの幅に入るので、素材の導線（＋ 画像／＋ BGM／＋ 効果音）が
 * 「押しても何も起きない」ように見えていた。openLeft() が leftPinned まで立てることを固定する。
 */
// 工具列は NativePreview の addBar に渡されるので、プレビューの代わりにそれだけ描く。
vi.mock('./NativePreview',()=>({NativePreview:forwardRef(({addBar}:any,ref)=>{
  useImperativeHandle(ref,()=>({pause:()=>{},flushManipulation:async()=>true}));
  return <div>{addBar}</div>;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props:any,ref)=>{
  useImperativeHandle(ref,()=>({blurDraft:()=>{},flush:async()=>true}));return null;
})}));
// Rec 5: NativeWorkspace は ref を渡すので forwardRef で受ける（素の関数だと React が ref 警告を出し、
// 次の担当が「壊れているのかも」と疑う）。
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((_props:any,ref)=>{
  // I-1: NativeTimelineHandle（NativeTimeline.tsx:75）と同形。空だと flush() 呼び出しが
  // 「is not a function」で Unhandled Rejection になる。
  useImperativeHandle(ref,()=>({flush:async()=>true,restoreCut:async()=>true,fitZoom:()=>{}}));return null;
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
  schemaVersion:2,id:'narrow-left',revision:0,name:'narrow-left',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:90,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false})}));

/** 窓幅 1100（= narrow）を ResizeObserver 越しに知らせる。jsdom は自前で通知しない。 */
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{
    constructor(private readonly callback:ResizeObserverCallback){}
    observe(){this.callback([{contentRect:{width:1100,height:800}} as ResizeObserverEntry],this as unknown as ResizeObserver);}
    disconnect(){}unobserve(){}
  });
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('幅 1100 で「＋ 画像」を押すと左カラムが開く（レールのままにしない）',()=>{
  const view=render(<NativeWorkspace projectId="narrow-left"/>);
  const workspace=view.container.querySelector('.native-workspace')!;
  expect(workspace.className).toContain('native-hide-left');   // 前提: 狭いので自動でレールに畳まれている
  const button=view.getByRole('button',{name:'＋ 画像'});
  expect(button).toBeTruthy();                                 // 存在検査（ボタンが無ければこの検査は何も言っていない）
  fireEvent.click(button);
  expect(workspace.className).not.toContain('native-hide-left');
  expect(workspace.getAttribute('style')).not.toContain('--native-left: 0px');
});
