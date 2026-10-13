/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {nativeDecodeStats} from './mp4FrameSource';
import {exportRendererOptions} from './exportSourceRelease';

// Fake decoders: each open() is one source; the log records the order of clone closes
// and source disposals, which is what the release must respect.
const fake=vi.hoisted(()=>({log:[] as string[],opens:[] as Array<{url:string;args:unknown[]}>,fail:new Set<string>()}));
vi.mock('./compositor',()=>({NativeCompositor:class {render(){}dispose(){}}}));
vi.mock('./mp4FrameSource',async importOriginal=>{
  const actual=await importOriginal<typeof import('./mp4FrameSource')>();
  class FakeSource {
    disposed=false;retainedBytes=1000;
    constructor(readonly name:string){}
    async acquire(){
      if(this.disposed)throw new Error('映像は閉じられています');
      if(fake.fail.has(this.name))throw new Error(`decode failed ${this.name}`);
      const name=this.name;
      return {frame:{close:()=>fake.log.push(`close ${name}`),displayWidth:320,displayHeight:180,visibleRect:{x:0,y:0,width:320,height:180}},identity:{sample:0,pts:{num:0,den:1},duration:{num:1,den:30}}};
    }
    dispose(){this.disposed=true;fake.log.push(`dispose ${this.name}`);}
  }
  return {...actual,
    httpByteSource:async(url:string)=>({size:1,url,read:async()=>new ArrayBuffer(0)}),
    Mp4FrameSource:{open:async(bytes:{url:string},...args:unknown[])=>{
      const name=/asset=([^&]+)/.exec(bytes.url)![1]!;fake.opens.push({url:bytes.url,args});fake.log.push(`open ${name}`);return new FakeSource(name);
    }}};
});

/** One track: a [0,2) b [2,4) a [4,6) c [6,8). */
function documentFixture():SequenceDocument {
  const order=['a','b','a','c'];
  return {schemaVersion:2,id:'release',name:'release',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:8,background:'#000000',transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:['a','b','c'].map(id=>({id,kind:'media',name:id,file:`media/${id}.mp4`,fingerprint:id.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(2),width:320,height:180,frameRate:r(30)}]})),
    tracks:[{id:'track',kind:'visual',name:'track',enabled:true}],
    clips:order.map((asset,i)=>({id:`clip-${i}`,name:`clip-${i}`,trackId:'track',startFrame:i*2,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'video',assetId:asset,streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}}))} as unknown as SequenceDocument;
}
const renderers:NativeSceneRenderer[]=[];
function renderer(options?:ConstructorParameters<typeof NativeSceneRenderer>[3]){
  const mount=document.createElement('div');document.body.append(mount);
  const value=new NativeSceneRenderer(mount,'release-project',undefined,options);renderers.push(value);return value;
}
const opened=(name:string)=>fake.log.filter(line=>line===`open ${name}`).length;
beforeEach(()=>{
  fake.log.length=fake.opens.length=0;fake.fail.clear();
  Object.assign(nativeDecodeStats,{sourcesOpened:0,sourcesReleased:{lastUse:0,overBudget:0}});
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(new Proxy({}, {get:()=>()=>{}}) as CanvasRenderingContext2D);
});
afterEach(()=>{for(const value of renderers.splice(0))value.dispose();vi.restoreAllMocks();});

it('export: releases each source after its last use, only after that frame\'s clone is closed, and keeps a returning source',async()=>{
  const value=renderer(exportRendererOptions(8)),plan=new ScenePlan(documentFixture());
  for(let frame=0;frame<8;frame++)await value.render(plan,frame);
  expect(fake.log).toEqual([
    'open a','close a','close a',
    'open b','close b','close b','dispose b',
    'close a','close a','dispose a',
    'open c','close c','close c','dispose c',
  ]);
  // The export retention reaches every open().
  expect(fake.opens.map(entry=>entry.args)).toEqual(Array(3).fill([0,{minFrames:8,maxBytes:512*1024*1024,keepDecoderOpen:true}]));
  expect(nativeDecodeStats).toMatchObject({sourcesOpened:3,sourcesReleased:{lastUse:3,overBudget:0}});
});
it('export: over the total of all sources, releases an idle returning source and opens it again when it returns',async()=>{
  const value=renderer({retention:{minFrames:8},release:{totalBytes:0}}),plan=new ScenePlan(documentFixture());
  for(let frame=0;frame<8;frame++)await value.render(plan,frame);
  expect(opened('a')).toBe(2);
  // a is not needed at frame 2: released right after frame 1, before b opens.
  expect(fake.log.slice(0,5)).toEqual(['open a','close a','close a','dispose a','open b']);
  expect(nativeDecodeStats.sourcesReleased).toEqual({lastUse:3,overBudget:1});
});
it('preview: opens with the default retention and never releases a source on its own',async()=>{
  const value=renderer(),plan=new ScenePlan(documentFixture());
  for(let frame=0;frame<8;frame++)await value.render(plan,frame);
  expect(fake.log.filter(line=>line.startsWith('dispose'))).toEqual([]);
  expect(fake.opens.map(entry=>entry.args)).toEqual(Array(3).fill([0]));
  value.dispose();await vi.waitFor(()=>expect(fake.log.filter(line=>line.startsWith('dispose')).sort()).toEqual(['dispose a','dispose b','dispose c']));
});
it('export: a failed frame still closes its clones, and disposal after the failure closes every open source',async()=>{
  const value=renderer(exportRendererOptions(8)),plan=new ScenePlan(documentFixture());
  await value.render(plan,0);fake.fail.add('b');
  await expect(value.render(plan,2)).rejects.toThrow('decode failed b');
  expect(fake.log).toEqual(['open a','close a','open b']);
  value.dispose();
  await vi.waitFor(()=>expect(fake.log.filter(line=>line.startsWith('dispose')).sort()).toEqual(['dispose a','dispose b']));
});
