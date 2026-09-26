/** @vitest-environment jsdom */
// src/app/native/NativePreview.shuttle.test.tsx
import {createRef} from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativePreview,type NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

// NativePreview.playbackRate.test.tsx と同じ最小モック。resume を止めると「準備中」を作れる。
const state=vi.hoisted(()=>({resume:vi.fn(),renderGate:vi.fn(),tick:null as FrameRequestCallback|null,transports:[] as Array<{playbackRate:number;sample:number;isPlaying:boolean}>}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  async render(plan:{document:SequenceDocument},frame:number){await state.renderGate();return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};}
  dispose(){}clear(){}
}}));
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  sample=0;isPlaying=false;
  constructor(readonly context:{sampleRate:number},_plan:unknown,_pcm:unknown,_error:(error:Error)=>void,readonly playbackRate=1){state.transports.push(this);}
  seek(sample:number){this.sample=sample;}currentSample(){return this.sample;}presentationSample(){return this.sample;}
  async play(){this.isPlaying=true;}pause(){this.isPlaying=false;}dispose(){this.pause();}
}}));
const document:SequenceDocument={schemaVersion:2,id:'shuttle',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{state.tick=callback;return 1;});
  vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;resume(){return state.resume();}async close(){}});
});
afterEach(()=>{cleanup();state.transports=[];state.tick=null;vi.unstubAllGlobals();vi.resetAllMocks();});
async function mount(onEnded?:()=>void){
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="shuttle" document={document} onFrame={()=>{}} bypassLut={false} onEnded={onEnded}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  return {ref,view};
}
const lastRate=()=>state.transports.at(-1)!.playbackRate;

it('停止中の L は等速で再生を始め、連打で 2・4・8 倍に上がる',async()=>{
  const {ref}=await mount();
  await act(async()=>ref.current!.shuttle('l',false));expect(lastRate()).toBe(1);
  await act(async()=>ref.current!.shuttle('l',false));expect(lastRate()).toBe(2);
  await act(async()=>ref.current!.shuttle('l',false));expect(lastRate()).toBe(4);
  await act(async()=>ref.current!.shuttle('l',false,4));expect(lastRate()).toBe(4);
});

it('音声準備中の L 連打も「再生中」として加速する',async()=>{
  const {ref}=await mount();let resume!:()=>void;
  state.resume.mockReturnValueOnce(new Promise<void>(resolve=>resume=resolve));
  await act(async()=>{ref.current!.shuttle('l',false);});
  expect(ref.current!.isPlaybackPending()).toBe(true);
  await act(async()=>{ref.current!.shuttle('l',false);});
  await act(async()=>{resume();});
  expect(lastRate()).toBe(2);
});

it('stop と toggle は速度を 1 に戻し、次の再生は等速',async()=>{
  const {ref}=await mount();
  await act(async()=>ref.current!.shuttle('l',false));await act(async()=>ref.current!.shuttle('l',false));
  expect(lastRate()).toBe(2);
  await act(async()=>ref.current!.stop());
  await act(async()=>ref.current!.play());expect(lastRate()).toBe(1);
  await act(async()=>ref.current!.shuttle('j',false));expect(lastRate()).toBe(-1);
  await act(async()=>ref.current!.toggle());
  await act(async()=>ref.current!.toggle());expect(lastRate()).toBe(1);
});

it('自然終了で速度が 1 に戻る',async()=>{
  const ended=vi.fn();const {ref}=await mount(ended);
  await act(async()=>ref.current!.shuttle('l',false));await act(async()=>ref.current!.shuttle('l',false));
  const transport=state.transports.at(-1)!;transport.sample=300*1600;transport.isPlaying=false;
  await act(async()=>state.tick!(16));
  expect(ended).toHaveBeenCalledTimes(1);
  await act(async()=>ref.current!.play());expect(lastRate()).toBe(1);
});

it('Shift+L はスロー 0.5 倍で入る',async()=>{
  const {ref}=await mount();
  await act(async()=>ref.current!.shuttle('l',true));
  expect(lastRate()).toBe(0.5);
});
