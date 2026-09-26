/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

// 画面の案内は「離すと確定、Esc・保存・画面切替で取消」。保存を押した直後にポインターが離れても
// 取消が先に始まっているよう、ドラッグ（プレビューの直接操作・タイムライン）の取消は押した時点で始める。
// 入力欄の確定は、保存の進捗を描いてから（104bdee3 の意図）。
const state=vi.hoisted(()=>({order:[] as string[]}));
const flushed=(name:string)=>vi.fn(async()=>{state.order.push(name);return true;});
const handles=vi.hoisted(()=>({manipulation:null as null|ReturnType<typeof vi.fn>,timeline:null as null|ReturnType<typeof vi.fn>,inspector:null as null|ReturnType<typeof vi.fn>,save:null as null|ReturnType<typeof vi.fn>}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:handles.manipulation}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:handles.timeline,restoreCut:async()=>true,fitZoom(){}}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:handles.inspector,blurDraft(){}}));return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false,resumeAutoSave(){}})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:true,document:{
  schemaVersion:2,id:'gesture',revision:1,name:'gesture',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
}},busy:false,execute:vi.fn(async()=>true),readCurrent:()=>({document:null}),save:handles.save})}));
beforeEach(()=>{
  state.order=[];handles.manipulation=flushed('manipulation');handles.timeline=flushed('timeline');handles.inspector=flushed('inspector');
  handles.save=vi.fn(async()=>{state.order.push('save');return true;});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('starts cancelling drags when save is pressed and commits field edits after the save indicator paints',async()=>{
  const view=render(<NativeWorkspace projectId="gesture"/>);
  fireEvent.click(view.getByRole('button',{name:/^保存$/}));
  // Synchronously, before the paint yield: a pointer release right after this cannot commit the drag.
  expect(state.order).toEqual(['timeline','manipulation']);
  expect(handles.inspector).not.toHaveBeenCalled();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));});
  expect(state.order).toEqual(['timeline','manipulation','inspector','save']);
});
