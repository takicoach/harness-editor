/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
/** カット確認（元素材プレビュー）の在／不在だけを切り替える。 */
const state=vi.hoisted(()=>({active:null as unknown}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{
  useImperativeHandle(ref,()=>({pause:()=>{},flushManipulation:async()=>true}));return null;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props:any,ref)=>{
  useImperativeHandle(ref,()=>({blurDraft:()=>{},flush:async()=>true}));return null;
})}));
// 「今この操作に適用する詰める」がそのまま観測できるように、渡された prop を出す。
vi.mock('./NativeTimeline',()=>({NativeTimeline:({ripple}:any)=><output data-testid="ripple-prop">{String(ripple)}</output>}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useCutSourcePreview',()=>({useCutSourcePreview:()=>({active:state.active,owners:[],clipId:'',pending:false,
  choose:()=>{},open:async()=>{},stop:()=>{},seekProgram:()=>{},onFrame:()=>{},marker:undefined})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'ripple-gate',revision:0,name:'ripple-gate',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:90,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false})}));
beforeEach(()=>{state.active=null;vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('カット確認中は「詰める」トグルが無効になり、挙動も OFF で渡る（最終広域レビュー I-2）',()=>{
  // 通常時: トグルは押せて、タイムラインには ON（既定）が渡る。
  const normal=render(<NativeWorkspace projectId="ripple-gate"/>);
  const toggle=normal.getByRole('button',{name:/詰める/}) as HTMLButtonElement;
  expect(toggle.disabled).toBe(false);
  expect(normal.getByTestId('ripple-prop').textContent).toBe('true');
  cleanup();
  // カット確認中: トグルが無効になるだけでなく、渡す値も false（表示と実態を一致させる）。
  state.active={serial:1,preview:null,initialFrame:0};
  const reviewing=render(<NativeWorkspace projectId="ripple-gate"/>);
  expect((reviewing.getByRole('button',{name:/詰める/}) as HTMLButtonElement).disabled).toBe(true);
  expect(reviewing.getByTestId('ripple-prop').textContent).toBe('false');
});
