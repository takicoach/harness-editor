/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativePreview,NATIVE_RESTORATION_TIMEOUT_MS,type NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

const state=vi.hoisted(()=>({resume:vi.fn(),renderGate:vi.fn(),created:vi.fn(),disposed:vi.fn(),presentation:vi.fn(),tick:null as FrameRequestCallback|null,
  audioErrors:[] as Array<(error:Error)=>void>,
  transports:[] as Array<{playbackRate:number;sample:number;isPlaying:boolean}>}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  constructor(){state.created();}
  async render(plan:{document:SequenceDocument},frame:number){await state.renderGate();return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};}
  dispose(){state.disposed();}clear(){}
}}));
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  sample=0;isPlaying=false;
  constructor(readonly context:{sampleRate:number},_plan:unknown,_pcm:unknown,error:(error:Error)=>void,readonly playbackRate=1){state.transports.push(this);state.audioErrors.push(error);}
  seek(sample:number){this.sample=sample;}currentSample(){return this.sample;}
  presentationSample(timestamp:number){return state.presentation(timestamp)??this.sample;}
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
afterEach(()=>{cleanup();state.transports=[];state.audioErrors=[];state.tick=null;vi.unstubAllGlobals();vi.resetAllMocks();});
async function mount(onPlaybackChanged?:(playing:boolean)=>void,onEnded?:()=>void){
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="shuttle" document={document} onFrame={()=>{}} bypassLut={false}
    onPlaybackChanged={onPlaybackChanged} onEnded={onEnded}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  return {ref,view};
}

it('renders the output presentation sample with the actual RAF timestamp while raw audio stays ahead',async()=>{
  const {ref}=await mount();await act(async()=>ref.current!.play());
  state.transports.at(-1)!.sample=16000;state.presentation.mockReturnValue(4800);
  await act(async()=>state.tick!(1234));
  expect(ref.current!.frame()).toBe(3);expect(state.presentation).toHaveBeenCalledWith(1234);
  expect(state.transports.at(-1)!.sample).toBe(16000);
});

it('shows circular progress while preparing playback and lets the user cancel it',async()=>{
  const {view}=await mount();let resume!:()=>void;
  state.resume.mockReturnValueOnce(new Promise<void>(resolve=>resume=resolve));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'再生'})));
  const progress=view.getByRole('progressbar',{name:'再生を準備しています…'});
  expect(progress.querySelector('.task-progress-ring svg')).not.toBeNull();
  expect(progress.getAttribute('aria-valuenow')).toBeNull();
  fireEvent.click(view.getByRole('button',{name:'再生準備を中止'}));
  expect(view.queryByRole('progressbar')).toBeNull();
  await act(async()=>resume());
  expect(state.transports).toHaveLength(0);
  expect(view.getByRole('button',{name:'再生'})).toBeTruthy();
});

it('keeps the new preparation indicator when an older cancelled request finishes',async()=>{
  const {ref,view}=await mount();let first!:()=>void,second!:()=>void;
  state.resume.mockReturnValueOnce(new Promise<void>(resolve=>first=resolve)).mockReturnValueOnce(new Promise<void>(resolve=>second=resolve));
  let a!:Promise<void>,b!:Promise<void>;
  await act(async()=>{a=ref.current!.play();});
  await act(async()=>{ref.current!.pause();b=ref.current!.play();});
  await act(async()=>{first();await a;});
  expect(view.getByRole('progressbar',{name:'再生を準備しています…'})).toBeTruthy();
  await act(async()=>{second();await b;});
  expect(view.queryByRole('progressbar')).toBeNull();
  expect(state.transports.at(-1)?.isPlaying).toBe(true);
});

it('starts audio at the requested subtitle frame when Play follows an unfinished seek',async()=>{
  const {ref}=await mount();let release!:()=>void;
  state.renderGate.mockReturnValueOnce(new Promise<void>(resolve=>release=resolve));
  let seeking!:Promise<void>,playing!:Promise<void>;
  await act(async()=>{seeking=ref.current!.seek(90);playing=ref.current!.play();});
  const startedBeforePixels=state.transports.some(transport=>transport.isPlaying);
  expect(ref.current!.frame()).toBe(0);
  await act(async()=>{release();await seeking;await playing;});
  expect(startedBeforePixels).toBe(false);
  expect(ref.current!.frame()).toBe(90);
  expect(state.transports.at(-1)).toMatchObject({sample:144000,isPlaying:true});
});

it('cancels Play waiting for a subtitle seek when a newer seek takes ownership',async()=>{
  const {ref}=await mount();let release!:()=>void;
  state.renderGate.mockReturnValueOnce(new Promise<void>(resolve=>release=resolve));
  let seeking!:Promise<void>,playing!:Promise<void>;
  await act(async()=>{seeking=ref.current!.seek(90);playing=ref.current!.play();});
  await act(async()=>ref.current!.seek(120));
  await act(async()=>{release();await seeking;await playing;});
  expect(ref.current!.frame()).toBe(120);
  expect(state.transports.some(transport=>transport.isPlaying)).toBe(false);
});

it('bounds a stalled subtitle seek before Play and recreates the renderer for retry',async()=>{
  const {ref,view}=await mount();let release!:()=>void;
  state.renderGate.mockReturnValueOnce(new Promise<void>(resolve=>release=resolve));
  vi.useFakeTimers();
  try{
    let seeking!:Promise<void>,playing!:Promise<void>;
    await act(async()=>{seeking=ref.current!.seek(90);playing=ref.current!.play();});
    await act(async()=>vi.advanceTimersByTimeAsync(NATIVE_RESTORATION_TIMEOUT_MS));
    expect(ref.current!.isPlaybackPending()).toBe(false);
    expect(view.getByRole('alert').textContent).toContain('タイムアウト');
    expect(state.created).toHaveBeenCalledTimes(2);expect(state.disposed).toHaveBeenCalledTimes(1);
    await act(async()=>{release();await seeking;await playing;});
    expect(ref.current!.frame()).toBe(0);
    await act(async()=>ref.current!.play());
    expect(state.transports.at(-1)).toMatchObject({sample:0,isPlaying:true});
    expect(view.queryByRole('alert')).toBeNull();
  }finally{vi.useRealTimers();}
});

it('cancels a stalled seek wait on newer input without later disposing its renderer',async()=>{
  const {ref}=await mount();state.renderGate.mockReturnValueOnce(new Promise(()=>{}));
  vi.useFakeTimers();
  try{
    let settled=false;
    await act(async()=>{void ref.current!.seek(90);void ref.current!.play().then(()=>{settled=true;});});
    await act(async()=>ref.current!.seek(120));expect(settled).toBe(true);
    await act(async()=>ref.current!.play());
    await act(async()=>vi.advanceTimersByTimeAsync(NATIVE_RESTORATION_TIMEOUT_MS+1));
    expect(state.created).toHaveBeenCalledTimes(1);expect(state.disposed).not.toHaveBeenCalled();
    expect(state.transports.at(-1)).toMatchObject({sample:192000,isPlaying:true});
  }finally{vi.useRealTimers();}
});

it('keeps the latest speed and seek when an earlier audio resume completes late',async()=>{
  const {ref}=await mount();let resume!:()=>void;
  state.resume.mockReturnValueOnce(new Promise<void>(resolve=>resume=resolve));
  let first!:Promise<void>;await act(async()=>{first=ref.current!.play();});
  expect(ref.current!.isPlaybackPending()).toBe(true);
  await act(async()=>{ref.current!.setPlaybackRate(4);});
  expect(state.transports.map(t=>t.playbackRate)).toEqual([4]);
  await act(async()=>{await ref.current!.seek(90);});
  expect(ref.current!.isPlaybackPending()).toBe(false);
  await act(async()=>{resume();await first;});
  expect(state.transports).toHaveLength(1);
  expect(state.transports[0]!.isPlaying).toBe(false);
  expect(ref.current!.frame()).toBe(90);
});

it('does not restart after a pause subscriber seeks during a speed change',async()=>{
  let seekOnPause=false;let handle:NativePreviewHandle;
  const {ref}=await mount(playing=>{if(!playing&&seekOnPause){seekOnPause=false;void handle.seek(75);}});handle=ref.current!;
  await act(async()=>ref.current!.play());seekOnPause=true;
  await act(async()=>ref.current!.setPlaybackRate(-2));
  expect(ref.current!.frame()).toBe(75);expect(state.transports).toHaveLength(1);
  expect(state.transports[0]!.isPlaying).toBe(false);
  await act(async()=>ref.current!.play());
  expect(state.transports.at(-1)!.playbackRate).toBe(-2);
});

it('restarts reverse from the last frame and publishes ended only at the first frame',async()=>{
  const ended=vi.fn(),changed=vi.fn(),{ref}=await mount(changed,ended);
  await act(async()=>{ref.current!.setPlaybackRate(-1);await ref.current!.play();});
  const transport=state.transports.at(-1)!;
  expect(transport.sample).toBe(299*1600);
  transport.sample=0;transport.isPlaying=false;
  await act(async()=>state.tick!(16));
  expect(ref.current!.frame()).toBe(0);expect(ended).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith(false);
});

it('can resume from a delayed revision draw callback before React commits ready state',async()=>{
  const ref=createRef<NativePreviewHandle>();let resumeFromDraw=false;
  const props={projectId:'shuttle',onFrame:()=>{},bypassLut:false,onRendered:()=>{if(resumeFromDraw){resumeFromDraw=false;void ref.current!.play();}}};
  const view=render(<NativePreview ref={ref} document={document} {...props}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());expect(state.transports).toHaveLength(1);
  let release!:()=>void;state.renderGate.mockReturnValueOnce(new Promise<void>(resolve=>release=resolve));
  view.rerender(<NativePreview ref={ref} document={{...document,revision:1,sequenceEndFrame:301}} {...props}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(true));
  // The host calls play synchronously inside onRendered, before any act/React
  // flush can replace the imperative handle's ready=false closure.
  resumeFromDraw=true;await act(async()=>release());
  expect(state.transports).toHaveLength(2);expect(state.transports[1]!.isPlaying).toBe(true);
});

it('keeps the live audio clock and its error owner during visual-only revisions',async()=>{
  const ref=createRef<NativePreviewHandle>(),changed=vi.fn(),onError=vi.fn();
  const props={projectId:'shuttle',onFrame:()=>{},bypassLut:false,onPlaybackChanged:changed,onError};
  const view=render(<NativePreview ref={ref} document={document} {...props}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());const before=changed.mock.calls.length;
  for(let revision=1;revision<=3;revision++){
    view.rerender(<NativePreview ref={ref} document={{...document,revision,background:revision%2?'#111111':'#222222'}} {...props}/>);
    await act(async()=>{});
  }
  expect(state.transports).toHaveLength(1);expect(state.transports[0]!.isPlaying).toBe(true);
  expect(changed.mock.calls.slice(before)).toEqual([]);
  await act(async()=>state.audioErrors[0]!(new Error('current audio failure')));
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({message:'current audio failure'}));
  expect(state.transports[0]!.isPlaying).toBe(false);
});

it('does not cancel pending audio resume for a visual-only revision',async()=>{
  const {ref,view}=await mount();let resume!:()=>void;
  state.resume.mockReturnValueOnce(new Promise<void>(resolve=>resume=resolve));
  let play!:Promise<void>;await act(async()=>{play=ref.current!.play();});
  view.rerender(<NativePreview ref={ref} projectId="shuttle" document={{...document,revision:1,background:'#123456'}} onFrame={()=>{}} bypassLut={false}/>);
  await act(async()=>{resume();await play;});
  expect(state.transports).toHaveLength(1);expect(state.transports[0]!.isPlaying).toBe(true);
});

it('retires the previous audio error owner when an audio-affecting revision replaces it',async()=>{
  const ref=createRef<NativePreviewHandle>(),onError=vi.fn(),props={projectId:'shuttle',onFrame:()=>{},bypassLut:false,onError};
  const view=render(<NativePreview ref={ref} document={document} {...props}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());
  view.rerender(<NativePreview ref={ref} document={{...document,revision:1,sequenceEndFrame:301}} {...props}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());
  await act(async()=>state.audioErrors[0]!(new Error('retired audio')));
  expect(onError).not.toHaveBeenCalled();expect(state.transports[1]!.isPlaying).toBe(true);
});
