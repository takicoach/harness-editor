/** @vitest-environment jsdom */
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useCutSourcePreview} from './useCutSourcePreview';
import type {NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

afterEach(cleanup);
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',revision:4,name:'編集',fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000',tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
  assets:[{id:'asset',kind:'media',name:'原本',file:'source.mp4',fingerprint:'a',streams:[{index:0,kind:'video',codec:'h264',duration:r(20),frameRate:r(60),width:320,height:180}]}],
  cutArchive:{version:1,entries:[{id:'cut',durationFrames:45,completionFloorFrames:45,origin:{cutId:'cut',startFrame:0,endFrame:45},boundary:{hintFrame:0,ambiguous:true,references:[]},tracks:[],clips:[{id:'owner',name:'映像',trackId:'v',startFrame:5,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(3),rate:r(2)}}]}]}};}
function setup(doc=fixture()){
  const transport={pause:vi.fn(),seek:vi.fn()},onProgramFrame=vi.fn(),onError=vi.fn();
  const props={projectId:'p',document:doc,mode:'finish',activeCutId:'cut',player:{current:transport as unknown as NativePreviewHandle},prepare:vi.fn(async()=>true),onError,onProgramFrame};
  const hook=renderHook(p=>useCutSourcePreview(p),{initialProps:props});
  return {...hook,props,transport,onProgramFrame,onError};
}
it('starts at exact selected source time and maps source frames through the saved speed without changing the editing clock',async()=>{
  const doc=fixture(),before=structuredClone(doc),h=setup(doc);
  await act(()=>h.result.current.open());
  expect(h.result.current.active?.initialFrame).toBe(180);
  expect(h.result.current.active?.preview.sequenceEndFrame).toBe(1200);
  act(()=>h.result.current.onFrame(240));
  expect(h.result.current.marker).toEqual({entryId:'cut',localFrame:20});
  expect(h.onProgramFrame).not.toHaveBeenCalled();expect(doc).toEqual(before);
  act(()=>h.result.current.onFrame(600));expect(h.result.current.marker).toBeNull();
  act(()=>h.result.current.stop());expect(h.result.current.active).toBeNull();expect(h.result.current.marker).toBeUndefined();
  expect(h.onProgramFrame).not.toHaveBeenCalled();
});
it('returns to a requested completion position instead of sending its frame number to the source player',async()=>{
  const h=setup();await act(()=>h.result.current.open());const stale=h.result.current.onFrame;
  act(()=>h.result.current.seekProgram(42));
  expect(h.result.current.active).toBeNull();expect(h.onProgramFrame).toHaveBeenCalledExactlyOnceWith(42);expect(h.transport.seek).not.toHaveBeenCalled();
  act(()=>stale(700));expect(h.onProgramFrame).toHaveBeenCalledTimes(1);
});
it.each(['mode','document','activeCutId','projectId'] as const)('discards an audition on %s change and rejects old frame notifications',async field=>{
  const h=setup();await act(()=>h.result.current.open());const stale=h.result.current.onFrame;
  const next={...h.props,[field]:field==='mode'?'review':field==='document'?{...h.props.document,revision:5}:'other'};
  h.rerender(next);expect(h.result.current.active).toBeNull();
  act(()=>stale(400));expect(h.onProgramFrame).not.toHaveBeenCalled();
});
it('requires explicit choice for repeated video uses of the same source and preserves their source offsets',async()=>{
  const doc=fixture(),clip=structuredClone(doc.cutArchive!.entries[0]!.clips[0]!);clip.id='other';if(clip.content.kind==='video')clip.content.sourceIn=r(9);doc.cutArchive!.entries[0]!.clips.push(clip);
  const h=setup(doc);expect(h.result.current.clipId).toBe('');await act(()=>h.result.current.open());expect(h.result.current.active).toBeNull();
  act(()=>h.result.current.choose('other'));await act(()=>h.result.current.open());expect(h.result.current.active?.initialFrame).toBe(540);
});
it('does not reopen after context switches away and back while a draft is flushing',async()=>{
  const h=setup();let resolve!:(ok:boolean)=>void;h.props.prepare.mockImplementationOnce(()=>new Promise<boolean>(r=>{resolve=r;}));
  let pending!:Promise<void>;act(()=>{pending=h.result.current.open();});
  h.rerender({...h.props,mode:'edit'});h.rerender(h.props);
  await act(async()=>{resolve(true);await pending;});expect(h.result.current.active).toBeNull();
});
it('keeps the program monitor when a draft cannot flush',async()=>{
  const h=setup();h.props.prepare.mockResolvedValue(false);await act(()=>h.result.current.open());
  expect(h.result.current.active).toBeNull();expect(h.transport.pause).not.toHaveBeenCalled();
});
it('does not resurrect an old source audition when cut selection moves away and back',async()=>{
  const h=setup();await act(()=>h.result.current.open());
  h.rerender({...h.props,activeCutId:'other'});h.rerender(h.props);
  expect(h.result.current.active).toBeNull();
});
it('opens against the latest document after a successful draft flush',async()=>{
  const h=setup(),next={...h.props.document,revision:5};
  let resolve!:(ok:boolean)=>void;h.props.prepare.mockImplementationOnce(()=>new Promise<boolean>(r=>{resolve=r;}));
  let pending!:Promise<void>;act(()=>{pending=h.result.current.open();});
  act(()=>h.result.current.stop(false));h.rerender({...h.props,document:next});
  await act(async()=>{resolve(true);await pending;});
  expect(h.result.current.active?.document?.revision).toBe(5);
});
it('routes an older completion-seek callback to the current program player after an edit closed the source',async()=>{
  const h=setup();await act(()=>h.result.current.open());const seek=h.result.current.seekProgram;
  act(()=>h.result.current.stop(false));
  act(()=>seek(42));expect(h.transport.seek).toHaveBeenCalledExactlyOnceWith(42);
});
it('starts inside the source usage when its in-point falls between source frames',async()=>{
  const doc=fixture(),clip=doc.cutArchive!.entries[0]!.clips[0]!;
  if(clip.content.kind==='video')clip.content.sourceIn=r(1,120);
  const h=setup(doc);await act(()=>h.result.current.open());
  expect(h.result.current.active?.initialFrame).toBe(1);expect(h.result.current.marker?.entryId).toBe('cut');
});
it('honors a completion seek made while source opening waits for a draft',async()=>{
  const h=setup();let resolve!:(ok:boolean)=>void;h.props.prepare.mockImplementationOnce(()=>new Promise<boolean>(r=>{resolve=r;}));
  let pending!:Promise<void>;act(()=>{pending=h.result.current.open();});
  act(()=>h.result.current.seekProgram(42));
  await act(async()=>{resolve(true);await pending;});
  expect(h.transport.seek).toHaveBeenCalledExactlyOnceWith(42);expect(h.result.current.active).toBeNull();
});
