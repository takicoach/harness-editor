/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

// I1: 試聴とタイムライン再生は排他でなければならない。
// - 試聴ボタンを押した時点でタイムラインのプレイヤーを止める。
// - タイムライン再生が始まったら試聴を止める。
// 両方とも実配線を検証したいので NativePreview だけモックし（pause を観測できる ref・onPlay を捕まえる）、
// useAssetAudition もモックして toggle/stop の呼び出しをそのまま観測する（実オーディオ再生は別テストの責務）。
const state=vi.hoisted(()=>({pause:vi.fn(),toggle:vi.fn(),stop:vi.fn(),onPlay:null as null|(()=>void)}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:any,ref)=>{
  useImperativeHandle(ref,()=>({pause:state.pause,flushManipulation:async()=>true}));
  state.onPlay=props.onPlay;
  return null;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useAssetAudition',()=>({useAssetAudition:()=>({playingId:null,toggle:state.toggle,stop:state.stop})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'audition',revision:0,name:'audition',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000',
  assets:[{id:'a1',name:'BGM素材',file:'public/BGM/bgm.wav',kind:'media',fingerprint:'a'.repeat(64),
    streams:[{kind:'audio',index:0,codec:'pcm_s16le',sampleRate:48000,channels:2,duration:{num:2,den:1}}]}],
  tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
}},busy:false,execute:vi.fn(async()=>true),readCurrent:()=>({document:null}),save:vi.fn(async()=>true)})}));
beforeEach(()=>{
  sessionStorage.clear();state.pause.mockReset();state.toggle.mockReset();state.stop.mockReset();state.onPlay=null;
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('タイムラインのプレイヤーを止めてから試聴を開始する',async()=>{
  const view=render(<NativeWorkspace projectId="audition"/>);
  fireEvent.click(view.getByRole('tab',{name:'素材'}));
  // B: 素材一覧は 4 タブ。BGM だけの案件なので既定の「動画」から「BGM」へ切り替えてから試聴する。
  fireEvent.click(view.getByRole('tab',{name:'BGM 1'}));
  fireEvent.click(await view.findByRole('button',{name:'BGM素材を試聴'}));
  expect(state.pause).toHaveBeenCalled();
  expect(state.toggle).toHaveBeenCalledWith('a1',expect.stringContaining('a1'),'bgm');
});
it('タイムライン再生が始まったら試聴を止める',()=>{
  render(<NativeWorkspace projectId="audition"/>);
  // マウント時の projectId エフェクトも stop() を1回呼ぶため、配線対象の呼び出しと混ざらないようここでリセットする。
  state.stop.mockClear();
  act(()=>{state.onPlay?.();});
  expect(state.stop).toHaveBeenCalled();
});
