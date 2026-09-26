/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativePreview,type NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

const draws=vi.hoisted(()=>({hold:false,frames:[] as number[],release:[] as Array<()=>void>,errors:new Map<number,Error>(),playing:false}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  async render(plan:{document:SequenceDocument},frame:number){
    draws.frames.push(frame);
    if(draws.hold)await new Promise<void>(resolve=>draws.release.push(resolve));
    if(draws.errors.has(frame))throw draws.errors.get(frame);
    return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};
  }
  dispose(){}clear(){}
}}));
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  sample=0;constructor(readonly context:{sampleRate:number}){}
  seek(sample:number){this.sample=sample;}currentSample(){return this.sample;}
  presentationSample(){return this.sample;}
  get isPlaying(){return draws.playing;}async play(){draws.playing=true;}pause(){draws.playing=false;}dispose(){this.pause();}
}}));
const doc:SequenceDocument={schemaVersion:2,id:'frame-step',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
beforeEach(()=>{
  vi.stubGlobal('AudioContext',class {sampleRate=48000;async resume(){}async close(){}});
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
});
afterEach(()=>{cleanup();draws.hold=false;draws.frames=[];draws.release=[];draws.errors.clear();draws.playing=false;vi.unstubAllGlobals();});
async function mount(){
  const ref=createRef<NativePreviewHandle>(),onFrame=vi.fn();
  const view=render(<NativePreview ref={ref} projectId="frame-step" document={doc} initialFrame={16} onFrame={onFrame} bypassLut={false}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  draws.frames=[];draws.hold=true;onFrame.mockClear();
  return {ref,view,onFrame};
}

it('accumulates review-seek arrow repeats while its displayed thumb is waiting for decoding',async()=>{
  const {ref,view}=await mount(),slider=view.getByRole('slider',{name:'シークバー'});
  for(const key of ['ArrowRight','ArrowRight','ArrowUp','ArrowDown','ArrowLeft'])fireEvent.keyDown(slider,{key,repeat:true});
  expect(draws.frames).toEqual([17,18,19,18,17]);expect(slider).toHaveProperty('value','16');
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(17);expect(slider).toHaveProperty('value','17');
});

it.each([
  {name:'previous twice',buttons:['1フレーム戻る（←）','1フレーム戻る（←）'],expected:[15,14],last:14},
  {name:'next twice',buttons:['1フレーム進む（→）','1フレーム進む（→）'],expected:[17,18],last:18},
  {name:'previous then next',buttons:['1フレーム戻る（←）','1フレーム進む（→）'],expected:[15,16],last:16},
])('preserves $name before the preceding draw completes',async({buttons,expected,last})=>{
  const {ref,view,onFrame}=await mount();
  for(const title of buttons)fireEvent.click(view.getByTitle(title));
  const requested=[...draws.frames];
  // A requested position must not be reported as already displayed. Resolve
  // newest first, then stale work, to exercise the real renderer ownership gate.
  expect(ref.current!.frame()).toBe(16);expect(onFrame).not.toHaveBeenCalled();
  await act(async()=>draws.release.at(-1)!());
  await act(async()=>draws.release[0]!());
  expect({requested,displayed:ref.current!.frame(),notifications:onFrame.mock.calls.map(([frame])=>frame)})
    .toEqual({requested:expected,displayed:last,notifications:[last]});
});

it('bases a relative button on the latest pending absolute seek',async()=>{
  const {ref,view,onFrame}=await mount();let pending!:Promise<void>;
  act(()=>{pending=ref.current!.seek(40);});
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  const requested=[...draws.frames];
  await act(async()=>draws.release[1]!());
  await act(async()=>{draws.release[0]!();await pending;});
  expect({requested,displayed:ref.current!.frame(),notifications:onFrame.mock.calls.map(([frame])=>frame)})
    .toEqual({requested:[40,39],displayed:39,notifications:[39]});
});

it('steps twice when each draw completes before the next button click',async()=>{
  const {ref,view,onFrame}=await mount();
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  await act(async()=>draws.release[0]!());
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  await act(async()=>draws.release[1]!());
  expect(draws.frames).toEqual([15,14]);expect(ref.current!.frame()).toBe(14);
  expect(onFrame.mock.calls.map(([frame])=>frame)).toEqual([15,14]);
});

it('clamps each requested step before accumulating the next step',async()=>{
  const {ref,view}=await mount();
  act(()=>{void ref.current!.seek(0);});
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  fireEvent.click(view.getByTitle('1フレーム進む（→）'));
  expect(draws.frames).toEqual([0,0,1]);
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(1);
});

it('does not lose a newer step when stale work completes first',async()=>{
  const {ref,view}=await mount();
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  await act(async()=>draws.release[0]!());
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.frames).toEqual([15,14,13]);
  await act(async()=>{draws.release[2]!();draws.release[1]!();});
  expect(ref.current!.frame()).toBe(13);
});

it('retires pending input when a new document replaces it',async()=>{
  const {ref,view}=await mount();
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  view.rerender(<NativePreview ref={ref} projectId="frame-step" document={{...doc,id:'replacement'}} initialFrame={16} onFrame={()=>{}} bypassLut={false}/>);
  fireEvent.click(view.getByTitle('1フレーム進む（→）'));
  expect(draws.frames).toEqual([15,16,17]);
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(17);
});

it('preserves a newer seek issued synchronously by a pause subscriber',async()=>{
  const ref=createRef<NativePreviewHandle>();let reenter=false;
  const view=render(<NativePreview ref={ref} projectId="frame-step" document={doc} initialFrame={16} onFrame={()=>{}} bypassLut={false}
    onPlaybackChanged={playing=>{if(!playing&&reenter){reenter=false;void ref.current!.seek(80);}}}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  draws.frames=[];draws.hold=true;reenter=true;
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.frames).toEqual([80,79]);
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(79);
});

it('bases recovery input on the displayed frame after a failed seek',async()=>{
  const {ref,view}=await mount();draws.errors.set(15,new Error('draw failed'));
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  await act(async()=>draws.release[0]!());
  expect(view.getByRole('alert').textContent).toContain('draw failed');
  fireEvent.click(view.getByTitle('1フレーム進む（→）'));
  expect(draws.frames).toEqual([15,17]);
  await act(async()=>draws.release[1]!());
  expect(ref.current!.frame()).toBe(17);expect(view.queryByRole('alert')).toBeNull();
});

it('stops playback before stepping and retains subsequent pending steps',async()=>{
  const {ref,view}=await mount();
  await act(async()=>ref.current!.play());expect(draws.playing).toBe(true);
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.playing).toBe(false);
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.frames).toEqual([15,14]);
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(14);expect(draws.playing).toBe(false);
});

it('does not let failed seek cleanup discard a newer seek from its pause notification',async()=>{
  const ref=createRef<NativePreviewHandle>();let recover=false;
  const view=render(<NativePreview ref={ref} projectId="frame-step" document={doc} initialFrame={16} onFrame={()=>{}} bypassLut={false}
    onPlaybackChanged={playing=>{if(!playing&&recover){recover=false;void ref.current!.seek(80);}}}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  draws.frames=[];draws.hold=true;draws.errors.set(15,new Error('old seek failed'));
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));recover=true;
  await act(async()=>draws.release[0]!());
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.frames).toEqual([15,80,79]);
  await act(async()=>{draws.release[2]!();draws.release[1]!();});
  expect(ref.current!.frame()).toBe(79);
});

it('does not carry pending requests across a project and document replacement',async()=>{
  const {ref,view}=await mount();
  act(()=>{void ref.current!.seek(299);void ref.current!.seekBy(1);void ref.current!.seekBy(-1);});
  expect(draws.frames).toEqual([299,299,298]);
  view.rerender(<NativePreview ref={ref} projectId="other-project" document={{...doc,id:'other-document'}} onFrame={()=>{}} bypassLut={false}/>);
  fireEvent.click(view.getByTitle('1フレーム戻る（←）'));
  expect(draws.frames.slice(3)).toEqual([16,15]);
  await act(async()=>{for(const release of [...draws.release].reverse())release();});
  expect(ref.current!.frame()).toBe(15);
});

it('switches monitor clocks at their mapped frame and ignores the old pending draw',async()=>{
  const {ref,view,onFrame}=await mount();
  const review={...doc,id:'cut-inclusive-preview',sequenceEndFrame:600};
  view.rerender(<NativePreview ref={ref} projectId="frame-step" document={review} initialFrame={130} onFrame={onFrame} bypassLut={false}/>);
  expect(draws.frames).toEqual([130]);
  view.rerender(<NativePreview ref={ref} projectId="frame-step" document={doc} initialFrame={30} onFrame={onFrame} bypassLut={false}/>);
  expect(draws.frames).toEqual([130,30]);
  await act(async()=>draws.release[1]!());await act(async()=>draws.release[0]!());
  expect(ref.current!.frame()).toBe(30);expect(onFrame.mock.calls.map(([f])=>f)).toEqual([30]);
});
