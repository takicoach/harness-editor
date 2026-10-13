/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
type PreviewProps={onRendered?(frame:number,geometry:null):void;onError?(failure:{message:string}):void};
const h=vi.hoisted(()=>({preview:null as null|PreviewProps,timeline:null as null|{beforeFirstPicture?:boolean},empty:false}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:PreviewProps,ref)=>{h.preview=props;useImperativeHandle(ref,()=>({pause(){},frame:()=>0,flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((props:{beforeFirstPicture?:boolean},_ref)=>{h.timeline=props;return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:vi.fn(),cancel(){},picker:null})}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>{
  const r=(n:number)=>({num:n,den:1}),states=new Map<boolean,unknown>();
  const state=(empty:boolean)=>{if(!states.has(empty))states.set(empty,{sessionId:'s',dirty:false,document:{schemaVersion:2,id:'p1',revision:0,name:'p1',fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:empty?0:300,background:'#000',
    assets:[{id:'movie',kind:'media',file:'.harness/assets/movie.mp4',name:'movie.mp4',fingerprint:'m'.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180}]}],
    tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    clips:empty?[]:[{id:'c',name:'movie.mp4',trackId:'v-main',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'video',assetId:'movie',streamIndex:0,sourceIn:r(0),rate:r(1)}}]}});return states.get(empty);};
  return {useNativeSession:()=>({state:state(h.empty),busy:false,reference:vi.fn(),upload:vi.fn(),execute:vi.fn(),readCurrent:()=>state(h.empty),accept:vi.fn(),appendToMain:vi.fn()})};
});
beforeEach(()=>{
  Reflect.deleteProperty(window,'harnessDesktop');sessionStorage.clear();localStorage.clear();h.preview=null;h.timeline=null;h.empty=false;
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('holds the timeline filmstrips until the preview reports its first picture, then never holds again',async()=>{
  render(<NativeWorkspace projectId="p1"/>);await waitFor(()=>expect(h.timeline).not.toBeNull());
  expect(h.preview?.onRendered).toBeTypeOf('function');expect(h.timeline!.beforeFirstPicture).toBe(true);
  act(()=>{h.preview!.onRendered!(0,null);});await waitFor(()=>expect(h.timeline!.beforeFirstPicture).toBe(false));
  act(()=>{h.preview!.onRendered!(1,null);});expect(h.timeline!.beforeFirstPicture).toBe(false);
});
it('releases the filmstrips when the preview fails instead of waiting for a picture that will not come',async()=>{
  render(<NativeWorkspace projectId="p1"/>);await waitFor(()=>expect(h.timeline?.beforeFirstPicture).toBe(true));
  act(()=>{h.preview!.onError!({message:'読めません'});});await waitFor(()=>expect(h.timeline!.beforeFirstPicture).toBe(false));
});
it('does not hold an empty sequence, which has no picture to wait for',async()=>{
  h.empty=true;render(<NativeWorkspace projectId="p1"/>);await waitFor(()=>expect(h.timeline).not.toBeNull());
  expect(h.timeline!.beforeFirstPicture).toBe(false);
});
