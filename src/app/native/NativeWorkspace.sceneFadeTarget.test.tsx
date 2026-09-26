/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
const state=vi.hoisted(()=>({order:[] as string[],gate:Promise.resolve(true)}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{
  useImperativeHandle(ref,()=>({pause:()=>{},flushManipulation:()=>{state.order.push('manipulation');return state.gate;}}));return null;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((props:any,ref)=>{
  useImperativeHandle(ref,()=>({blurDraft:()=>{state.order.push('blur');},flush:async()=>{state.order.push('inspector');return true;}}));
  return <output data-testid="fade-state">{String(props.sceneFadeSwitching)}:{props.sceneFadeTarget.kind}</output>;
})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:({onSceneFade}:any)=><button onClick={()=>onSceneFade({kind:'tail'})}>timeline tail</button>}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'fade-target',revision:0,name:'fade-target',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:90,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false})}));
beforeEach(()=>{state.order=[];vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each([true,false])('protects timeline target changes before async flush and recovers after success=%s',async success=>{
  let release!:(value:boolean)=>void;state.gate=new Promise(resolve=>{release=resolve;});
  const view=render(<NativeWorkspace projectId="fade-target"/>);
  fireEvent.click(view.getByText('timeline tail'));
  expect(state.order).toEqual(['blur','manipulation']);
  expect(view.getByTestId('fade-state').textContent).toBe('true:head');
  fireEvent.click(view.getByText('timeline tail'));
  expect(state.order).toEqual(['blur','manipulation']);
  await act(async()=>{release(success);});
  await waitFor(()=>expect(view.getByTestId('fade-state').textContent).toBe(success?'false:tail':'false:head'));
  expect(state.order).toEqual(success?['blur','manipulation','inspector']:['blur','manipulation']);
});
