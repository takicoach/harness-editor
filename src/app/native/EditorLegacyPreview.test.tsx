/** @vitest-environment jsdom */
import { createRef, startTransition, Suspense, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorLegacyPreview, type EditorLegacyPreviewHandle } from './EditorLegacyPreview';
import type { SequenceDocument } from '../../core/sequence/model';
import type { LegacyPreviewState } from './useLegacyPreview';
import { rational } from '../../core/sequence/time';

const state = vi.hoisted(() => ({render:vi.fn(),geometry:vi.fn(),resume:vi.fn(),play:vi.fn(),pause:vi.fn(),sample:0,playing:true,tick:()=>{}}));
vi.mock('../../preview/native/previewBridge', () => ({NativePreviewBridge: class {
  async render(plan:{document:SequenceDocument},frame:number) {
    await state.render(frame);
    return state.geometry() ?? {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[],graphics:[]};
  }
  clear(){} dispose(){}
}}));
vi.mock('../../preview/native/audioTransport', () => ({NativeAudioTransport:class {
  constructor(readonly context:{sampleRate:number}){}
  seek(){} async play(){state.play();} pause(){state.pause();} dispose(){}
  currentSample(){return state.sample;} get isPlaying(){return state.playing;}
  presentationSample(){return state.sample;}
}}));
const document:SequenceDocument={schemaVersion:2,id:'doc',name:'接続検証',revision:1,fps:rational(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
const ready=(revision=1,legacyContext='one',sequenceEndFrame=30):Extract<LegacyPreviewState,{status:'ready'}>=>({status:'ready',projectId:'legacy',document:{...document,revision,sequenceEndFrame},legacyContext,notices:[],error:null,retry:vi.fn()});
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>{state.tick=callback;return 1;}); vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){await state.resume();}async close(){}});
  state.sample=0;state.playing=true;
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.resetAllMocks();});

it('publishes only the last of five unpainted seeks with matching geometry, retaining the same facade through rerender/recovery',async()=>{
  const ref=createRef<EditorLegacyPreviewHandle>(),frames:number[]=[],onFrame=vi.fn(),preview=ready();
  const view=render(<EditorLegacyPreview ref={ref} preview={preview} initialFrame={10} onFrame={onFrame} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(10)); const facade=ref.current!;
  facade.addEventListener('frameupdate',event=>{expect(facade.getGeometry()?.frame).toBe(event.detail.frame);frames.push(event.detail.frame);});
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});state.render.mockReturnValue(pending);
  act(()=>{for(let i=0;i<5;i++)facade.seekBy!(1);});
  expect(facade.getCurrentFrame()).toBe(10);expect(frames).toEqual([]);
  await act(async()=>{release();}); expect(frames).toEqual([15]);
  view.rerender(<EditorLegacyPreview ref={ref} preview={preview} initialFrame={15} onFrame={onFrame} bypassLut={false}/>);
  expect(ref.current).toBe(facade);
  view.rerender(<EditorLegacyPreview ref={ref} preview={{status:'pending',document:null,notices:[],error:null,retry:vi.fn()}} initialFrame={15} onFrame={onFrame} bypassLut={false}/>);
  expect(facade.getGeometry()).toBeNull();
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'two')} initialFrame={15} onFrame={onFrame} bypassLut={false}/>);
  await waitFor(()=>expect(facade.getGeometry()?.revision).toBe(2));
  expect(ref.current).toBe(facade);expect(frames).toEqual([15,15]);
});

it('cancels play during audio resume and never announces playback from a retired lease',async()=>{
  const ref=createRef<EditorLegacyPreviewHandle>(),played=vi.fn(),preview=ready();
  const view=render(<EditorLegacyPreview ref={ref} preview={preview} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  ref.current!.addEventListener('play',played);
  let release!:()=>void;state.resume.mockReturnValue(new Promise<void>(resolve=>{release=resolve;}));
  act(()=>{ref.current!.play();ref.current!.pause();}); await act(async()=>{release();});
  expect(played).not.toHaveBeenCalled();expect(state.play).not.toHaveBeenCalled();expect(ref.current!.isPlaying()).toBe(false);
  state.resume.mockReturnValue(new Promise<void>(resolve=>{release=resolve;}));
  act(()=>ref.current!.play());
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'two')} onFrame={()=>{}} bypassLut={false}/>);
  await act(async()=>{release();});expect(played).not.toHaveBeenCalled();expect(state.play).not.toHaveBeenCalled();
});

it('announces actual playback/end, survives ref refresh while playing, and stops on resource-context replacement',async()=>{
  const ref=createRef<EditorLegacyPreviewHandle>(),events:string[]=[],preview=ready();
  const view=render(<EditorLegacyPreview ref={ref} preview={preview} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  for(const event of ['play','pause','ended'] as const)ref.current!.addEventListener(event,()=>events.push(event));
  await act(async()=>{ref.current!.play();});expect(events).toEqual(['play']);expect(ref.current!.isPlaying()).toBe(true);
  view.rerender(<EditorLegacyPreview ref={ref} preview={preview} onFrame={()=>{}} bypassLut={false}/>);
  expect(ref.current!.isPlaying()).toBe(true);expect(events).toEqual(['play']);
  state.sample=48000;state.playing=false;
  await act(async()=>{state.tick();});expect(events).toEqual(['play','pause','ended']);
  expect(ref.current!.getCurrentFrame()).toBe(29);expect(ref.current!.getGeometry()?.frame).toBe(29);
  state.playing=true;await act(async()=>{ref.current!.play();});
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'replacement')} onFrame={()=>{}} bypassLut={false}/>);
  expect(ref.current!.isPlaying()).toBe(false);expect(events).toEqual(['play','pause','ended','play','pause']);
});

it('reports an asynchronous seek failure once and isolates a throwing subscriber from the renderer and other subscribers',async()=>{
  const ref=createRef<EditorLegacyPreviewHandle>(),error=vi.fn(),observed=vi.fn();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} onFrame={()=>{}} bypassLut={false} onError={error}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  ref.current!.addEventListener('frameupdate',()=>{throw new Error('subscriber');});
  ref.current!.addEventListener('frameupdate',observed);
  await act(async()=>{ref.current!.seekTo(3);});
  expect(observed).toHaveBeenCalledOnce();expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'subscriber'}));
  expect(view.queryByRole('alert')).toBeNull();
  error.mockClear();state.render.mockRejectedValue(new Error('seek failed'));
  await act(async()=>{ref.current!.seekTo(8);});
  expect(error).toHaveBeenCalledTimes(1);expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'seek failed'}));
  expect(ref.current!.getCurrentFrame()).toBe(3);expect(ref.current!.isPlaying()).toBe(false);
});

it('does not overwrite a newer seek requested by a pause subscriber',async()=>{
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>{ref.current!.play();});
  ref.current!.addEventListener('pause',()=>ref.current!.seekTo(10));
  await act(async()=>{ref.current!.seekTo(3);});
  expect(ref.current!.getCurrentFrame()).toBe(10);
});


it('does not deliver an old draw failure to a host installed by its pause subscriber', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>(), oldError = vi.fn(), newError = vi.fn();
  let replaceHost!: () => void;
  const first = ready(), second = ready(2, 'B');
  function Host() {
    const [replaced, setReplaced] = useState(false);
    replaceHost = () => setReplaced(true);
    return <EditorLegacyPreview ref={ref} preview={replaced ? second : first} onFrame={() => {}} bypassLut={false} onError={replaced ? newError : oldError}/>;
  }
  const view = render(<Host/>);
  await waitFor(() => expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { ref.current!.play(); });
  const onPause = () => flushSync(replaceHost);
  ref.current!.addEventListener('pause', onPause);
  state.render.mockRejectedValueOnce(new Error('old draw'));
  state.sample = 1600;
  await act(async () => { state.tick(); });
  ref.current!.removeEventListener('pause', onPause);
  expect(ref.current!.getGeometry()?.revision).toBe(2);
  expect(newError).not.toHaveBeenCalled();
  expect(view.queryByRole('alert')).toBeNull();
});

it('retires a seek superseded by LUT before the next relative input', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>(), preview = ready();
  const view = render(<EditorLegacyPreview ref={ref} preview={preview} initialFrame={13} onFrame={() => {}} bypassLut={false}/>);
  await waitFor(() => expect(ref.current!.getCurrentFrame()).toBe(13));
  let release!: () => void;
  state.render.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  act(() => ref.current!.seekTo(12));
  view.rerender(<EditorLegacyPreview ref={ref} preview={preview} initialFrame={13} onFrame={() => {}} bypassLut={true}/>);
  await waitFor(() => expect(state.render).toHaveBeenLastCalledWith(13));
  await act(async () => {});
  // The obsolete draw is still pending: completion cannot be our only cancellation signal.
  await act(async () => { ref.current!.seekBy!(1); });
  expect(ref.current!.getCurrentFrame()).toBe(14);
  await act(async () => { release(); });
  expect(ref.current!.getCurrentFrame()).toBe(14);
});

it('keeps an unfinished seek as the relative-input base while Play waits, and cancels that Play on a newer seek', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>();
  const view = render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={() => {}} bypassLut={false}/>);
  await waitFor(() => expect(ref.current!.getCurrentFrame()).toBe(13));
  let release!: () => void;
  state.render.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  act(() => ref.current!.seekTo(12));
  await act(async () => { ref.current!.play(); });
  expect(view.getByRole('button', {name:'再生準備を中止'})).toBeTruthy();
  expect(ref.current!.getCurrentFrame()).toBe(13);
  expect(state.play).not.toHaveBeenCalled();
  // Pending frame 12 + 2, not the last displayed frame 13 + 2.
  await act(async () => { ref.current!.seekBy!(2); });
  expect(ref.current!.getCurrentFrame()).toBe(14);
  expect(ref.current!.isPlaybackPending!()).toBe(false);
  await act(async () => { release(); });
  expect(ref.current!.getCurrentFrame()).toBe(14);
  expect(state.play).not.toHaveBeenCalled();
});


it('restores a seek requested before the native document effect has prepared its plan', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>();
  function Host() {
    useLayoutEffect(() => { ref.current!.seekTo(12); }, []);
    return <EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={() => {}} bypassLut={false}/>;
  }
  render(<Host/>);
  await waitFor(() => expect(ref.current!.getCurrentFrame()).toBe(12));
  expect(state.render).toHaveBeenCalledWith(12);
  await act(async () => { ref.current!.seekBy!(1); });
  expect(ref.current!.getCurrentFrame()).toBe(13);
});

it('retires a seek cancelled by a synchronous pause subscriber starting play', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>();
  render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={() => {}} bypassLut={false}/>);
  await waitFor(() => expect(ref.current!.getCurrentFrame()).toBe(13));
  await act(async () => { ref.current!.play(); });
  const restart = () => ref.current!.play();
  ref.current!.addEventListener('pause', restart);
  await act(async () => { ref.current!.seekTo(12); });
  ref.current!.removeEventListener('pause', restart);
  act(() => ref.current!.pause());
  expect(state.render).not.toHaveBeenCalledWith(12);
  await act(async () => { ref.current!.seekBy!(1); });
  expect(ref.current!.getCurrentFrame()).toBe(14);
});


it('keeps the newer seek started by an actual native draw-failure pause subscriber', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>(), error = vi.fn();
  render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={() => {}} bypassLut={false} onError={error}/>);
  await waitFor(() => expect(ref.current!.getCurrentFrame()).toBe(13));
  await act(async () => { ref.current!.play(); });
  const recover = () => ref.current!.seekTo(20);
  ref.current!.addEventListener('pause', recover);
  let release!: () => void;
  state.render.mockRejectedValueOnce(new Error('old playback draw'))
    .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  state.sample = 22400; // frame 14: this playing draw fails before recovery frame 20.
  await act(async () => { state.tick(); });
  ref.current!.removeEventListener('pause', recover);
  expect(error).toHaveBeenCalledOnce();
  expect(state.render).toHaveBeenLastCalledWith(20);
  expect(ref.current!.getCurrentFrame()).toBe(13);
  await act(async () => { ref.current!.seekBy!(1); });
  expect(ref.current!.getCurrentFrame()).toBe(21);
  await act(async () => { release(); });
  expect(ref.current!.getCurrentFrame()).toBe(21);
});


it('retains the latest seek while resources prepare and across a second document replacement', async () => {
  const ref = createRef<EditorLegacyPreviewHandle>(), frames:number[] = [];
  const pending: LegacyPreviewState = {status:'pending',document:null,notices:[],error:null,retry:vi.fn()};
  const view = render(<EditorLegacyPreview ref={ref} preview={pending} onFrame={()=>{}} bypassLut={false}/>);
  const facade = ref.current!; facade.addEventListener('frameupdate', event => frames.push(event.detail.frame));
  act(() => {facade.seekTo(20);facade.seekBy!(2);});
  let release!: () => void;
  state.render.mockImplementation(() => new Promise<void>(resolve => {release = resolve;}));
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready()} onFrame={()=>{}} bypassLut={false}/>);
  expect(facade.getCurrentFrame()).toBe(0);
  // Retire this document before its initial draw acknowledges the deferred seek.
  state.render.mockResolvedValue(undefined);
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'two')} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(() => expect(facade.getCurrentFrame()).toBe(22));
  expect(frames).toEqual([22]); expect(ref.current).toBe(facade);
  await act(async () => {release();});
  expect(facade.getCurrentFrame()).toBe(22);
});


it('resumes same-document audio-changing revisions after their actual draw while keeping preparation observable', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));
  await act(async()=>{ref.current!.play();});
  let release!:()=>void;state.render.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'one',29)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  expect(ref.current!.isPlaybackPending?.()).toBe(true);
  expect(ref.current!.isPlaying()).toBe(false);
  await act(async()=>{release();});
  await waitFor(()=>expect(ref.current!.isPlaying()).toBe(true));
  expect(ref.current!.getGeometry()?.revision).toBe(2);
});


it.each(['pause','seek','context','failure','subscriber'] as const)('cancels live-revision restart on %s before its draw finishes', async operation => {
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));await act(async()=>{ref.current!.play();});
  let release!:()=>void,reject!:(error:Error)=>void;
  state.render.mockImplementationOnce(()=>new Promise<void>((resolve,fail)=>{release=resolve;reject=fail;}));
  if(operation==='subscriber')ref.current!.addEventListener('pause',()=>ref.current!.pause());
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'one',29)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  if(operation==='pause')act(()=>ref.current!.pause());
  if(operation==='seek')act(()=>ref.current!.seekTo(20));
  if(operation==='context')view.rerender(<EditorLegacyPreview ref={ref} preview={ready(3,'replacement')} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await act(async()=>{operation==='failure'?reject(new Error('revision draw failure')):release();});
  expect(ref.current!.isPlaying()).toBe(false);expect(ref.current!.isPlaybackPending?.()).toBe(false);
  if(operation==='seek')expect(ref.current!.getCurrentFrame()).toBe(20);
});


it('keeps the real transport and public playing state during visual-only revisions', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));await act(async()=>{ref.current!.play();});
  const paused=vi.fn();ref.current!.addEventListener('pause',paused);const pauseCount=state.pause.mock.calls.length;
  let release!:()=>void;state.render.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  expect(ref.current!.isPlaying()).toBe(true);expect(paused).not.toHaveBeenCalled();expect(state.pause).toHaveBeenCalledTimes(pauseCount);
  await act(async()=>{release();});
  expect(ref.current!.getGeometry()?.revision).toBe(2);expect(state.play).toHaveBeenCalledOnce();expect(ref.current!.isPlaying()).toBe(true);
});


it('stops a retained visual-update clock immediately on explicit seek', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));await act(async()=>{ref.current!.play();});
  let release!:()=>void;state.render.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await act(async()=>{ref.current!.seekTo(20);});expect(ref.current!.isPlaying()).toBe(false);expect(ref.current!.getCurrentFrame()).toBe(20);
  await act(async()=>{release();});expect(ref.current!.getCurrentFrame()).toBe(20);expect(state.play).toHaveBeenCalledOnce();
});

it('disconnects on unmount after a newer visual render was suspended before commit', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>(),suspended=vi.fn(),never=new Promise<void>(()=>{});let update!:(revision:number)=>void;
  function Block():never{suspended();throw never;}
  function Host(){const [revision,setRevision]=useState(1);update=setRevision;return <Suspense fallback={<span>waiting</span>}><EditorLegacyPreview ref={ref} preview={ready(revision)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>{revision===2&&<Block/>}</Suspense>;}
  const view=render(<Host/>);await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));
  const facade=ref.current!;await act(async()=>{facade.play();});
  act(()=>startTransition(()=>update(2)));expect(suspended).toHaveBeenCalled();expect(facade.getGeometry()?.revision).toBe(1);
  view.unmount();expect(facade.isPlaying()).toBe(false);expect(facade.isPlaybackPending?.()).toBe(false);
});

it('carries the latest unpainted seek through a same-audio visual handoff', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>(),frames:number[]=[];let release!:()=>void;
  state.render.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  ref.current!.addEventListener('frameupdate',event=>frames.push(event.detail.frame));act(()=>{ref.current!.seekTo(20);});
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(20));expect(frames).toEqual([20]);
  await act(async()=>{release();});expect(frames).toEqual([20]);
});

it('keeps an audio-changing revision restart when another visual revision arrives before its first draw', async () => {
  const ref=createRef<EditorLegacyPreviewHandle>();
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));await act(async()=>{ref.current!.play();});
  let release!:()=>void;state.render.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2,'one',29)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  expect(ref.current!.isPlaybackPending?.()).toBe(true);
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(3,'one',29)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.isPlaying()).toBe(true));expect(ref.current!.getGeometry()?.revision).toBe(3);
  await act(async()=>{release();});expect(ref.current!.isPlaying()).toBe(true);expect(state.play).toHaveBeenCalledTimes(2);
});


it.each(['revision','documentId','frame'] as const)('rejects stale %s metadata delivered through the current visual callback', async field => {
  const ref=createRef<EditorLegacyPreviewHandle>(),frames:number[]=[];
  const view=render(<EditorLegacyPreview ref={ref} preview={ready()} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(ref.current!.getCurrentFrame()).toBe(13));ref.current!.addEventListener('frameupdate',event=>frames.push(event.detail.frame));
  const stale={documentId:'doc',revision:2,frame:13,resolution:document.resolution,videos:[],graphics:[],[field]:field==='revision'?1:field==='frame'?12:'old-doc'};
  state.geometry.mockReturnValueOnce(stale);
  view.rerender(<EditorLegacyPreview ref={ref} preview={ready(2)} initialFrame={13} onFrame={()=>{}} bypassLut={false}/>);
  await act(async()=>{});
  expect(ref.current!.getGeometry()).toBeNull();expect(frames).toEqual([]);
  await act(async()=>{ref.current!.seekTo(20);});expect(ref.current!.getGeometry()?.revision).toBe(2);expect(frames).toEqual([20]);
});
