/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import type {AcquiredFrame} from './mp4FrameSource';

const gpu=vi.hoisted(()=>({render:vi.fn()}));
vi.mock('./compositor',()=>({NativeCompositor:class {render=gpu.render;dispose(){}}}));
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const gate=()=>{let resolve!:(value:AcquiredFrame)=>void,reject!:(error:unknown)=>void;const promise=new Promise<AcquiredFrame>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};
const frame=()=>({frame:{close:vi.fn(),displayWidth:320,displayHeight:180,visibleRect:{x:0,y:0,width:320,height:180}} as unknown as VideoFrame,identity:{sample:0,pts:r(0),duration:r(1,30)}});
function documentFixture():SequenceDocument {
  return {schemaVersion:2,id:'acquisition',name:'acquisition',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000000',transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:Array.from({length:4},(_,i)=>({id:`asset-${i}`,kind:'media',name:`asset-${i}`,file:`media/${i}.mp4`,fingerprint:String(i).repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(2),width:320,height:180,frameRate:r(30)}]})),
    tracks:Array.from({length:4},(_,i)=>({id:`track-${i}`,kind:'visual',name:`track-${i}`,enabled:true})),
    clips:Array.from({length:4},(_,i)=>({id:`clip-${i}`,name:`clip-${i}`,trackId:`track-${i}`,startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'video',assetId:`asset-${i}`,streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}}))};
}
const cleanups:Array<()=>Promise<void>>=[];
beforeEach(()=>{
  gpu.render.mockClear();Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(new Proxy({}, {get:()=>()=>{}}) as CanvasRenderingContext2D);
});
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each([404,200])('checks failed legacy image HTTP status %s without labeling corrupt images as expired', async status => {
  const mount=document.createElement('div');document.body.append(mount);
  const renderer=new NativeSceneRenderer(mount,'legacy',(asset)=>`/api/legacy-preview/asset?id=legacy&context=lease&asset=${asset}`);
  const decodeError=new Error('invalid image');
  const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:vi.fn().mockRejectedValue(decodeError)});
  const cancel=vi.fn(async()=>{}),fetcher=vi.fn(async()=>({ok:status===200,status,body:{cancel}}));vi.stubGlobal('fetch',fetcher);
  const doc=documentFixture();doc.assets=[{id:'image',kind:'image',name:'image',file:'image.png',fingerprint:'a'.repeat(64),streams:[]}];
  doc.clips=[{...doc.clips[0]!,content:{kind:'image',assetId:'image'}}];
  try {
    const work=renderer.render(new ScenePlan(doc),0);
    if(status===404)await expect(work).rejects.toMatchObject({kind:'context-unavailable',status:404,resource:'asset'});
    else await expect(work).rejects.toBe(decodeError);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]).toEqual([expect.stringContaining('/api/legacy-preview/asset'),expect.objectContaining({headers:{Range:'bytes=0-0'}})]);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { renderer.dispose();mount.remove();if(originalDecode)Object.defineProperty(HTMLImageElement.prototype,'decode',originalDecode);else delete (HTMLImageElement.prototype as {decode?:unknown}).decode; }
});
function setup(){
  const mount=document.createElement('div');document.body.append(mount);
  const renderer=new NativeSceneRenderer(mount,'acquisition-project');const gates=Array.from({length:4},gate),frames=Array.from({length:4},frame),calls:number[]=[];
  vi.spyOn(renderer as unknown as {frame:(doc:unknown,visual:any)=>Promise<AcquiredFrame>},'frame').mockImplementation((_doc,visual)=>{const i=Number(visual.clip.id.split('-')[1]);calls.push(i);return gates[i]!.promise;});
  let current=true,settled=false;
  const work=renderer.render(new ScenePlan(documentFixture()),0,false,()=>current).then(()=>{settled=true;return undefined;},error=>{settled=true;return error;});
  cleanups.push(async()=>{current=false;for(let i=0;i<4;i++)gates[i]!.resolve(frames[i]!);await work;if(!(renderer as unknown as {disposed:boolean}).disposed)renderer.dispose();await flush();mount.remove();});
  return {renderer,gates,frames,calls,work,cancel:()=>{current=false;},settled:()=>settled};
}
it('starts two independent decodes before either finishes, bounds concurrency and cancels queued work',async()=>{
  const test=setup();await flush();expect(test.calls).toEqual([0,1]);
  test.gates[0]!.resolve(test.frames[0]!);await flush();expect(test.calls).toEqual([0,1,2]);
  test.cancel();test.gates[1]!.resolve(test.frames[1]!);test.gates[2]!.resolve(test.frames[2]!);
  expect(await test.work).toBeUndefined();expect(test.calls).toEqual([0,1,2]);
  for(const i of [0,1,2])expect(test.frames[i]!.frame.close).toHaveBeenCalledTimes(1);
  expect(test.frames[3]!.frame.close).not.toHaveBeenCalled();expect(gpu.render).not.toHaveBeenCalled();
});
it('waits for the other in-flight decode on failure and releases its late frame exactly once',async()=>{
  const test=setup(),error=new Error('second source failed');await flush();expect(test.calls).toEqual([0,1]);
  test.gates[1]!.reject(error);await flush();expect(test.settled()).toBe(false);expect(test.calls).toEqual([0,1]);
  test.gates[0]!.resolve(test.frames[0]!);expect(await test.work).toBe(error);
  expect(test.frames[0]!.frame.close).toHaveBeenCalledTimes(1);expect(gpu.render).not.toHaveBeenCalled();
});
it('reports failed sources in scene order rather than completion order',async()=>{
  const test=setup(),first=new Error('first source failed'),second=new Error('second source failed');await flush();expect(test.calls).toEqual([0,1]);
  test.gates[1]!.reject(second);await flush();test.gates[0]!.reject(first);expect(await test.work).toBe(first);
  expect(test.calls).toEqual([0,1]);expect(gpu.render).not.toHaveBeenCalled();
});
it('does not paint or retain frames completing after disposal',async()=>{
  const test=setup();await flush();expect(test.calls).toEqual([0,1]);test.renderer.dispose();
  test.gates[0]!.resolve(test.frames[0]!);test.gates[1]!.resolve(test.frames[1]!);
  expect(String(await test.work)).toMatch(/閉じ/);expect(test.calls).toEqual([0,1]);
  expect(test.frames[0]!.frame.close).toHaveBeenCalledTimes(1);expect(test.frames[1]!.frame.close).toHaveBeenCalledTimes(1);expect(gpu.render).not.toHaveBeenCalled();
});
it('paints in scene order when independent sources finish in reverse order',async()=>{
  const test=setup();await flush();
  for(const i of [1,2,3]){test.gates[i]!.resolve(test.frames[i]!);await flush();}
  expect(test.calls).toEqual([0,1,2,3]);expect(gpu.render).not.toHaveBeenCalled();
  test.gates[0]!.resolve(test.frames[0]!);expect(await test.work).toBeUndefined();
  expect(gpu.render.mock.calls.map(call=>call[0].map((layer:{id:string})=>layer.id))).toEqual([['clip-0'],['clip-1'],['clip-2'],['clip-3']]);
  for(const value of test.frames)expect(value.frame.close).toHaveBeenCalledTimes(1);
  expect(test.renderer.geometry()?.videos.map(value=>value.clipId)).toEqual(['clip-0','clip-1','clip-2','clip-3']);
});

it('passes the grade of both main and inserted video to the compositor without leaking it to an ungraded video',async()=>{
  const doc=documentFixture();doc.clips=doc.clips.slice(0,3);
  const grade={brightness:17,contrast:23,saturation:-100,temperature:31};
  const ids=['main-video','insert-video','ungraded-video'];
  doc.clips.forEach((clip,index)=>{
    clip.id=ids[index]!;
    if(index<2)clip.visual!.colorGrade={...grade};
  });
  const mount=document.createElement('div');document.body.append(mount);
  const renderer=new NativeSceneRenderer(mount,'color-scope');
  const frames=Array.from({length:3},frame);
  vi.spyOn(renderer as unknown as {frame:(doc:unknown,visual:any)=>Promise<AcquiredFrame>},'frame')
    .mockImplementation(async(_doc,visual)=>frames[ids.indexOf(visual.clip.id)]!);
  try {
    await renderer.render(new ScenePlan(doc),0);
    // Inspect the real scene renderer's draw boundary, not just ScenePlan values.
    // GPU pixel/curve correctness is separately checked by the external heavy gate.
    const layers=gpu.render.mock.calls.flatMap(call=>call[0]);
    expect(layers.map(layer=>({id:layer.id,grade:layer.grade}))).toEqual([
      {id:'main-video',grade},{id:'insert-video',grade},{id:'ungraded-video',grade:undefined},
    ]);
    expect(layers.map(layer=>layer.source)).toEqual(frames.map(value=>value.frame));
    for(const value of frames)expect(value.frame.close).toHaveBeenCalledTimes(1);
  } finally {renderer.dispose();mount.remove();}
});
