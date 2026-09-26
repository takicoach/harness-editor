/** @vitest-environment jsdom */
import {createRef,StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {NativePreview,NATIVE_RESTORATION_TIMEOUT_MS,type NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import { PreviewResourceError } from '../../preview/native/previewError';

const lifecycle=vi.hoisted(()=>({created:vi.fn(),disposed:vi.fn(),rendered:vi.fn(),manipulation:vi.fn(),audioError:vi.fn(),flush:vi.fn(),reload:vi.fn()}));
const playback=vi.hoisted(()=>({sample:0}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  constructor(){lifecycle.created();}
  async render(){const failure=await lifecycle.rendered();if(failure instanceof Error)throw failure;return {documentId:'doc',revision:0,frame:0,resolution:{width:320,height:180},videos:[]};}
  dispose(){lifecycle.disposed();}
  clear(){}
  async reload(){return lifecycle.reload();}
}}));

it.each(['info', 'data'] as const)('notifies the host of PCM %s 404 for imperative play without parsing its error body', async endpoint => {
  vi.stubGlobal('ResizeObserver', class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:1,fps:r(30),resolution:{width:16,height:16},sequenceEndFrame:30,background:'#000000',
    assets:[{id:'media',name:'音声',kind:'media',file:'.harness/assets/a.mp4',fingerprint:'a'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',duration:r(1),sampleRate:48000,channels:2}]}],
    tracks:[{id:'audio',name:'音声',kind:'audio',enabled:true}],clips:[{id:'clip',name:'音声',trackId:'audio',startFrame:0,durationFrames:30,
      clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'audio',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const parseError = vi.fn(async () => { throw new Error('non-JSON body'); });
  vi.stubGlobal('fetch', vi.fn(async (url:string) => endpoint === 'info' || !url.includes('/audio/info')
    ? {ok:false,status:404,json:parseError} : {ok:true,json:async()=>({url:'/pcm',sampleCount:2,sampleRate:48000,rate:r(1)})}));
  const ref=createRef<NativePreviewHandle>(),onError=vi.fn();
  const view=render(<NativePreview ref={ref} projectId="legacy" document={document} legacyContext="lease" onFrame={()=>{}} bypassLut={false} onError={onError}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>{await expect(ref.current!.play()).rejects.toMatchObject({status:404});});
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({kind:'context-unavailable',status:404,resource:'pcm'}));
  expect(parseError).not.toHaveBeenCalled();
});

it('notifies a current renderer failure without treating ordinary native 404 as lease expiry', async () => {
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  lifecycle.rendered.mockReturnValue(new PreviewResourceError('missing asset',404,'asset',false));
  const onError=vi.fn(), view=render(<NativePreview projectId="native" document={document} onFrame={()=>{}} bypassLut={false} onError={onError}/>);
  await waitFor(()=>expect(view.getByRole('alert').textContent).toBe('missing asset'));
  expect(onError).toHaveBeenLastCalledWith({kind:'resource',message:'missing asset',status:404,resource:'asset'});
});
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  constructor(readonly context:{sampleRate:number},_plan:unknown,_pcm:unknown,onError:(error:Error)=>void){lifecycle.audioError(onError);}
  currentSample(){return playback.sample;}get isPlaying(){return true;}
  presentationSample(){return playback.sample;}
  seek(){}async play(){}pause(){}dispose(){}
}}));
vi.mock('./NativePreviewManipulation',async()=>{
  const {forwardRef,useImperativeHandle}=await import('react');
  return {NativePreviewManipulation:forwardRef((props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true,restore:async()=>lifecycle.flush()??true,cancel:()=>{}}));lifecycle.manipulation(props);return null;})};
});

it('does not refill a new context cache when an old, already-read PCM body completes late',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:1,fps:r(30),resolution:{width:16,height:16},sequenceEndFrame:30,background:'#000000',
    assets:[{id:'media',name:'同じ凍結素材',kind:'media',file:'.harness/assets/a.mp4',fingerprint:'a'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',duration:r(1),sampleRate:48000,channels:2}]}],
    tracks:[{id:'audio',name:'音声',kind:'audio',enabled:true}],clips:[{id:'clip',name:'音声',trackId:'audio',startFrame:0,durationFrames:30,
      clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'audio',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  let finish!:()=>void,reading!:()=>void;
  const waiting=new Promise<void>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{reading=resolve;});
  const infoContexts:string[]=[],signals:AbortSignal[]=[];let bodies=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string,options:{signal:AbortSignal})=>{
    if(url.includes('/audio/info')){
      infoContexts.push(new URL(url,'http://localhost').searchParams.get('context')!);signals.push(options.signal);
      return {ok:true,json:async()=>({sampleCount:2,sampleRate:48000,url:'/private-pcm',rate:r(1)})};
    }
    const bytes=new Float32Array([.25,.25,.5,.5]).buffer,first=++bodies===1;
    return {ok:true,arrayBuffer:async()=>{if(first){reading();await waiting;}return bytes;}};
  }));
  const ref=createRef<NativePreviewHandle>(),view=render(<NativePreview ref={ref} projectId="same" document={document} legacyContext="token-A" onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  let oldPlay!:Promise<void>;await act(async()=>{oldPlay=ref.current!.play();await started;});
  view.rerender(<NativePreview ref={ref} projectId="same" document={document} legacyContext="token-B" onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));expect(signals[0]!.aborted).toBe(true);
  await act(async()=>{finish();await oldPlay;});await act(async()=>ref.current!.play());
  expect(infoContexts).toEqual(['token-A','token-B']);
});

it('does not erase a newer audio failure when an earlier frame finishes drawing',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const ref=createRef<NativePreviewHandle>(),view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());
  let finish!:()=>void;const drawing=new Promise<void>(resolve=>finish=resolve);lifecycle.rendered.mockReturnValueOnce(drawing);
  view.rerender(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={true}/>);
  await act(async()=>lifecycle.audioError.mock.lastCall![0](new Error('音声の再生が遅れました')));
  expect(view.getByRole('alert').textContent).toBe('音声の再生が遅れました');
  await act(async()=>finish());
  expect(view.getByRole('alert').textContent).toBe('音声の再生が遅れました');
  expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(true);
});
it.each(['success','failure','project-change'] as const)('waits for superseding canonical drawing: %s',async outcome=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const manipulation={selected:[],disabled:false,externalBusy:false,readDocument:()=>document,prepare:async()=>true,commit:async()=>true,commitShape:async()=>true,onBusy:()=>{}};
  const ref=createRef<NativePreviewHandle>(),view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  let first!:()=>void,next!:(error?:Error)=>void;
  lifecycle.rendered.mockReturnValueOnce(new Promise<void>(resolve=>first=resolve)).mockReturnValueOnce(new Promise<Error|undefined>(resolve=>next=resolve));
  let finished=false,restoration!:Promise<unknown>;
  await act(async()=>{
    restoration=lifecycle.manipulation.mock.lastCall![0].render(null,true).then((value:unknown)=>{finished=true;return value;},(error:Error)=>{finished=true;return error;});
    if(outcome==='project-change')view.rerender(<NativePreview ref={ref} projectId="other" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
    else ref.current!.seek(1);
  });
  await act(async()=>first());
  if(outcome==='project-change'){
    expect(await restoration).toBeInstanceOf(Error);await act(async()=>next());expect(view.queryByRole('alert')).toBeNull();
  }else{
    expect(finished).toBe(false);
    await act(async()=>next(outcome==='failure'?new Error('最新描画に失敗'):undefined));
    const result=await restoration;expect(result).toBeDefined();expect(finished).toBe(true);
    if(outcome==='failure'){expect(result).toBeInstanceOf(Error);expect(view.getByRole('alert').textContent).toBe('最新描画に失敗');}
    else expect(result).not.toBeInstanceOf(Error);
  }
});

it('does not start playback before manipulation flush has restored canonical pixels',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const resume=vi.fn();vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){resume();}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const manipulation={selected:[],disabled:false,externalBusy:false,readDocument:()=>document,prepare:async()=>true,commit:async()=>true,commitShape:async()=>true,onBusy:()=>{}};
  const ref=createRef<NativePreviewHandle>(),view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  let finish!:(ok:boolean)=>void;lifecycle.flush.mockReturnValueOnce(new Promise<boolean>(resolve=>finish=resolve));
  let playing!:Promise<void>;await act(async()=>{playing=ref.current!.play();});expect(resume).not.toHaveBeenCalled();
  await act(async()=>finish(false));await playing;expect(resume).not.toHaveBeenCalled();
  lifecycle.flush.mockReturnValueOnce(new Promise<boolean>(resolve=>finish=resolve));
  await act(async()=>{playing=ref.current!.play();});
  await act(async()=>ref.current!.seek(1));await act(async()=>finish(true));await playing;expect(resume).not.toHaveBeenCalled();
  await act(async()=>ref.current!.play());expect(resume).toHaveBeenCalledOnce();
});
it('bounds restoration, disposes the stalled renderer, retries on a fresh one and ignores its late failure',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const manipulation={selected:[],disabled:false,externalBusy:false,readDocument:()=>document,prepare:async()=>true,commit:async()=>true,commitShape:async()=>true,onBusy:()=>{}};
  const view=render(<NativePreview projectId="test" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  vi.useFakeTimers();let finishOld!:(error:Error)=>void;
  lifecycle.rendered.mockReturnValueOnce(new Promise<Error>(resolve=>finishOld=resolve));
  let settled=false,result!:Promise<unknown>;
  try{
    await act(async()=>{result=lifecycle.manipulation.mock.lastCall![0].render(null,true).then(()=>{settled=true;return null;},(error:Error)=>{settled=true;return error;});});
    await act(async()=>vi.advanceTimersByTimeAsync(NATIVE_RESTORATION_TIMEOUT_MS-1));expect(settled).toBe(false);
    await act(async()=>vi.advanceTimersByTimeAsync(1));expect(await result).toBeInstanceOf(Error);
    expect(lifecycle.created).toHaveBeenCalledTimes(2);expect(lifecycle.disposed).toHaveBeenCalledTimes(1);
    expect(view.getByRole('alert').textContent).toContain('タイムアウト');expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false);
    await act(async()=>{expect(await lifecycle.manipulation.mock.lastCall![0].render(null,true)).toBeDefined();});
    expect(view.queryByRole('alert')).toBeNull();const recovered=lifecycle.manipulation.mock.lastCall![0].geometry;
    await act(async()=>finishOld(new Error('古い描画の遅延失敗')));
    expect(view.queryByRole('alert')).toBeNull();expect(lifecycle.manipulation.mock.lastCall![0].geometry).toEqual(recovered);
    await act(async()=>{expect(await lifecycle.manipulation.mock.lastCall![0].render(null,true)).toBeDefined();});
    view.unmount();expect(lifecycle.disposed).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it('resumes playback drawing after a stalled playback tick is abandoned by restoration timeout',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('cancelAnimationFrame',()=>{});
  let tick:FrameRequestCallback|undefined;vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{tick=callback;return 1;});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:90,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const manipulation={selected:[],disabled:false,externalBusy:false,readDocument:()=>document,prepare:async()=>true,commit:async()=>true,commitShape:async()=>true,onBusy:()=>{}};
  const ref=createRef<NativePreviewHandle>(),view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  vi.useFakeTimers();await act(async()=>ref.current!.play());
  let finishTick!:()=>void;lifecycle.rendered.mockReturnValueOnce(new Promise<void>(resolve=>finishTick=resolve));
  playback.sample=1600;const beforeTick=lifecycle.rendered.mock.calls.length;
  await act(async()=>tick!(16));expect(lifecycle.rendered).toHaveBeenCalledTimes(beforeTick+1);
  await act(async()=>ref.current!.pause());lifecycle.rendered.mockReturnValueOnce(new Promise(()=>{}));
  let restoration!:Promise<unknown>;
  await act(async()=>{restoration=lifecycle.manipulation.mock.lastCall![0].render(null,true).catch((error:Error)=>error);});
  await act(async()=>vi.advanceTimersByTimeAsync(NATIVE_RESTORATION_TIMEOUT_MS));expect(await restoration).toBeInstanceOf(Error);
  await act(async()=>{await lifecycle.manipulation.mock.lastCall![0].render(null,true);await ref.current!.play();});
  const recovered=lifecycle.rendered.mock.calls.length;playback.sample=3200;
  await act(async()=>tick!(32));expect(lifecycle.rendered).toHaveBeenCalledTimes(recovered+1);expect(ref.current!.frame()).toBe(2);
  // A late completion from the discarded renderer must not unlock an in-flight
  // draw on the replacement renderer and admit overlapping playback requests.
  let finishNew!:()=>void;lifecycle.rendered.mockReturnValueOnce(new Promise<void>(resolve=>finishNew=resolve));
  playback.sample=4800;await act(async()=>tick!(48));const pending=lifecycle.rendered.mock.calls.length;
  await act(async()=>finishTick());playback.sample=6400;await act(async()=>tick!(64));expect(lifecycle.rendered).toHaveBeenCalledTimes(pending);
  await act(async()=>finishNew());await act(async()=>tick!(80));expect(ref.current!.frame()).toBe(4);expect(view.queryByRole('alert')).toBeNull();
});
afterEach(()=>{cleanup();playback.sample=0;vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});
it('recreates its renderer and reaches ready after StrictMode cleanup/setup',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const view=render(<StrictMode><NativePreview projectId="test" document={document} onFrame={()=>{}} bypassLut={false}/></StrictMode>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  expect(lifecycle.created).toHaveBeenCalledTimes(2);expect(lifecycle.disposed).toHaveBeenCalledTimes(1);expect(lifecycle.rendered.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('surfaces a failed canonical manipulation render and recovers on a successful seek',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const manipulation={selected:[],disabled:false,externalBusy:false,readDocument:()=>document,prepare:async()=>true,commit:async()=>true,commitShape:async()=>true,onBusy:()=>{}};
  const view=render(<NativePreview projectId="test" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  lifecycle.rendered.mockReturnValue(new Error('映像を読み込めません'));
  await act(async()=>{await expect(lifecycle.manipulation.mock.lastCall![0].render({...document,revision:1},false)).rejects.toThrow('映像を読み込めません');});
  view.rerender(<NativePreview projectId="test" document={{...document,revision:1}} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  expect(view.getByRole('alert').textContent).toBe('映像を読み込めません');
  expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(true);
  expect(lifecycle.manipulation.mock.lastCall![0].geometry).toBeNull();
  lifecycle.rendered.mockReturnValue(undefined);
  await act(async()=>view.getByTitle('1フレーム進む（→）').click());
  await waitFor(()=>expect(view.queryByRole('alert')).toBeNull());
  expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false);
});

it('does not pause when shape draw starts while stopped',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  vi.stubGlobal('fetch',vi.fn(async()=>{return {ok:true,json:async()=>({sampleCount:2,sampleRate:48000,url:'/pcm',rate:r(1)}),arrayBuffer:async()=>new Float32Array([.25,.25]).buffer};}));
  const onPlaybackChanged=vi.fn();
  const shapeDraw={kind:'rect' as const,disabled:false,color:'#ffffff',onPick:vi.fn(),onComplete:vi.fn(async()=>true)};
  const view=render(<NativePreview projectId="test" document={document} onFrame={()=>{}} bypassLut={false} shapeDraw={shapeDraw} onPlaybackChanged={onPlaybackChanged}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  expect((view.getByLabelText('再生') as HTMLButtonElement).getAttribute('data-playing')).toBe('false');
  onPlaybackChanged.mockClear();
  const stage=view.container.querySelector('.native-preview-stage') as HTMLElement;
  vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:320,height:180,right:320,bottom:180} as DOMRect);
  Object.defineProperty(stage,'setPointerCapture',{value:()=>{},configurable:true});
  stage.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:100,clientY:100,bubbles:true,pointerId:1}));
  expect(onPlaybackChanged).not.toHaveBeenCalled();
});

it('pauses when shape draw starts while playing',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const onPlaybackChanged=vi.fn();
  const shapeDraw={kind:'rect' as const,disabled:false,color:'#ffffff',onPick:vi.fn(),onComplete:vi.fn(async()=>true)};
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false} shapeDraw={shapeDraw} onPlaybackChanged={onPlaybackChanged}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.play());
  expect(view.container.querySelector('.native-play')!.getAttribute('data-playing')).toBe('true');
  onPlaybackChanged.mockClear();
  const stage=view.container.querySelector('.native-preview-stage') as HTMLElement;
  vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:320,height:180,right:320,bottom:180} as DOMRect);
  Object.defineProperty(stage,'setPointerCapture',{value:()=>{},configurable:true});
  stage.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:100,clientY:100,bubbles:true,pointerId:1}));
  expect(onPlaybackChanged).toHaveBeenCalledWith(false);
});

it('reloads the preview bridge once and restores the current frame while staying stopped',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.seek(5));
  expect(ref.current!.frame()).toBe(5);
  await act(async()=>{view.getByRole('button',{name:'プレビューを再読み込み'}).click();});
  await waitFor(()=>expect(lifecycle.reload).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect((view.getByRole('button',{name:'プレビューを再読み込み'}) as HTMLButtonElement).disabled).toBe(false));
  expect(ref.current!.frame()).toBe(5);
  expect((view.getByLabelText('再生') as HTMLButtonElement).getAttribute('data-playing')).toBe('false');
});

it('notifies a reload failure without touching the current position or document',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:3,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="test" document={document} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>ref.current!.seek(4));
  // T21 Minor: revision だけを見る assert はテストが自分で作った fixture を見ているだけで
  // 恒真だった。NativePreview には編集の書き込み口が無い、という主張そのものを確かめるため、
  // 渡した document オブジェクト全体が失敗後も一致することを見る。
  const before=structuredClone(document);
  lifecycle.reload.mockRejectedValueOnce(new Error('iframe起動に失敗しました'));
  await act(async()=>{view.getByRole('button',{name:'プレビューを再読み込み'}).click();});
  await waitFor(()=>expect(view.getByRole('alert').textContent).toContain('表示のみ・編集内容は保たれています'));
  expect(view.getByRole('alert').textContent).toContain('位置を指定し直すか、再生で再試行してください');
  expect(ref.current!.frame()).toBe(4);
  expect(document).toEqual(before);
  expect((view.getByRole('button',{name:'プレビューを再読み込み'}) as HTMLButtonElement).disabled).toBe(false);
});

it('does not throw and notifies when the fullscreen API is unavailable',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const document:SequenceDocument={schemaVersion:2,id:'doc',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const view=render(<NativePreview projectId="test" document={document} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  // jsdom には requestFullscreen が存在しない（未対応環境の再現そのもの）。
  expect((view.container.querySelector('.native-preview-box') as {requestFullscreen?:unknown}).requestFullscreen).toBeUndefined();
  // R2-M2: 全画面中は見出しごと隠れて案内が読めない。入る前のボタンに戻り方を書いておく。
  expect(view.getByRole('button',{name:'全画面で表示'}).getAttribute('title')).toContain('Esc');
  expect(()=>view.getByRole('button',{name:'全画面で表示'}).click()).not.toThrow();
  await waitFor(()=>expect(view.getByRole('alert').textContent).toBe('全画面にできませんでした。ブラウザの設定を確認してください。'));
});
