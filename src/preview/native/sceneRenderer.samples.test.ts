/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r,timeNumber} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';

// Fake decoders whose frame identity follows the requested source time (60 samples per second).
vi.mock('./compositor',()=>({NativeCompositor:class {render(){}dispose(){}}}));
vi.mock('./mp4FrameSource',async importOriginal=>{
  const actual=await importOriginal<typeof import('./mp4FrameSource')>();
  class FakeSource {
    retainedBytes=0;
    async acquire(time:{num:number;den:number}){
      const sample=Math.floor(timeNumber(time)*60+1e-9);
      return {frame:{close(){},displayWidth:320,displayHeight:180,visibleRect:{x:0,y:0,width:320,height:180}},identity:{sample,pts:{num:sample,den:60},duration:{num:1,den:60}}};
    }
    dispose(){}
  }
  return {...actual,httpByteSource:async(url:string)=>({size:1,url,read:async()=>new ArrayBuffer(0)}),Mp4FrameSource:{open:async()=>new FakeSource()}};
});

/** Two layers: a on the lower track for [0,4), b on the upper track for [2,4). */
function documentFixture():SequenceDocument {
  const visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};
  return {schemaVersion:2,id:'samples',name:'samples',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:5,background:'#000000',transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:['a','b'].map(id=>({id,kind:'media',name:id,file:`media/${id}.mp4`,fingerprint:id.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(10),width:320,height:180,frameRate:r(60)}]})),
    tracks:[{id:'low',kind:'visual',name:'low',enabled:true},{id:'high',kind:'visual',name:'high',enabled:true}],
    clips:[
      {id:'under',name:'under',trackId:'low',startFrame:0,durationFrames:4,clock:{offset:r(0),rate:r(1),duration:r(4)},content:{kind:'video',assetId:'a',streamIndex:0,sourceIn:r(1),rate:r(1)},visual},
      {id:'over',name:'over',trackId:'high',startFrame:2,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'video',assetId:'b',streamIndex:0,sourceIn:{num:58,den:60},rate:r(1)},visual},
    ]} as unknown as SequenceDocument;
}
let value:NativeSceneRenderer;
beforeEach(()=>{
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(new Proxy({}, {get:()=>()=>{}}) as CanvasRenderingContext2D);
  const mount=document.createElement('div');document.body.append(mount);
  value=new NativeSceneRenderer(mount,'samples-project');
});
afterEach(()=>{value.dispose();vi.restoreAllMocks();});

it('records which source sample each video layer of the drawn frame used',async()=>{
  const plan=new ScenePlan(documentFixture());
  expect(value.frameSamples()).toEqual([]);
  await value.render(plan,0);
  expect(value.frameSamples()).toEqual([{clip:'under',source:`${'a'.repeat(64)}:0`,sample:60,pts:{num:60,den:60}}]);
  await value.render(plan,3);
  // 30p output of 60p sources: 1 s + 3/30 s is sample 66; 58/60 s + 1/30 s is sample 60.
  expect(value.frameSamples()).toEqual([
    {clip:'under',source:`${'a'.repeat(64)}:0`,sample:66,pts:{num:66,den:60}},
    {clip:'over',source:`${'b'.repeat(64)}:0`,sample:60,pts:{num:60,den:60}},
  ]);
  // A frame without video has no samples (not the previous frame's).
  await value.render(plan,4);
  expect(value.frameSamples()).toEqual([]);
});
