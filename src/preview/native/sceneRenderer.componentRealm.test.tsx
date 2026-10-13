/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {runInNewContext} from 'node:vm';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';

const received=vi.hoisted(()=>({telop:[] as Array<Record<string,any>>,image:[] as Array<Record<string,any>>,title:[] as Array<Record<string,any>>}));
vi.mock('./compositor',()=>({NativeCompositor:class {dispose(){}}}));
vi.mock('../../capturePage/layers',async original=>({...await original<object>(),CaptureTitleLayer:(props:Record<string,any>)=>{received.title.push(props);return null;}}));
afterEach(()=>{vi.restoreAllMocks();received.telop.length=0;received.image.length=0;received.title.length=0;document.body.replaceChildren();});

const Telop=({segment}:{segment:Record<string,any>})=>{received.telop.push(segment);return null;};
const InsertImage=({segment}:{segment:Record<string,any>})=>{received.image.push(segment);return null;};
const visual=()=>({layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'fade' as const,frames:6},exit:{kind:'none' as const,frames:0}});
const source=():SequenceDocument=>({schemaVersion:2,id:'realm',name:'realm',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',
  transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
  rendering:{imageComponentAssetId:'image-component',telopBottomOffset:null,telopFontSize:null},
  assets:[{id:'telop-component',kind:'component',name:'自作テロップ',file:'telop.mjs',fingerprint:'t'.repeat(64),streams:[]},
    {id:'image-component',kind:'component',name:'自作画像',file:'image.mjs',fingerprint:'i'.repeat(64),streams:[]},
    {id:'picture',kind:'image',name:'picture.png',file:'media/picture.png',fingerprint:'p'.repeat(64),streams:[]}],
  tracks:[{id:'v1',name:'字幕',kind:'visual',enabled:true},{id:'v2',name:'タイトル',kind:'visual',enabled:true},{id:'v3',name:'画像',kind:'visual',enabled:true}],
  clips:[
    {id:'telop',name:'字幕',trackId:'v1',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},visual:visual(),
      content:{kind:'telop',textMode:'component',componentAssetId:'telop-component',data:{text:'自作',animation:'none',extra:{words:['自','作']}} as never}},
    {id:'title',name:'タイトル',trackId:'v2',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},visual:visual(),
      content:{kind:'title',data:{text:'題',extra:{lines:['題']}} as never,style:{top:20,left:15,fontSize:24}}},
    {id:'image',name:'画像',trackId:'v3',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},visual:visual(),
      content:{kind:'image',assetId:'picture',style:'plain'}}]});
const deepFreeze=<T,>(value:T):T=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};
/** プレビューで親（エディタ）の計画をそのまま受け取った状態: 計画の文書が別のレルムの物。 */
function parentRealmPlan():ScenePlan {
  const plan=new ScenePlan(source()),foreign=deepFreeze(runInNewContext('JSON.parse(text)',{text:JSON.stringify(plan.document)}) as SequenceDocument);
  expect(foreign.clips instanceof Array).toBe(false);
  Object.defineProperty(plan,'document',{value:foreign});return plan;
}
async function draw(plan:ScenePlan,frames:number[]){
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  vi.spyOn(NativeSceneRenderer.prototype as unknown as {bundle(id:string):Promise<Record<string,unknown>>},'bundle').mockImplementation(async id=>id==='telop-component'?{Telop}:{InsertImage});
  const container=document.createElement('div');document.body.append(container);
  const renderer=new NativeSceneRenderer(container,'realm-project');
  try{for(const frame of frames)await renderer.render(plan,frame);}finally{renderer.dispose();}
}
it('hands user components props of this page\'s realm, copied once per clip, when the plan comes from the parent (設計 §2-5)',async()=>{
  const plan=parentRealmPlan(),clip=(id:string)=>plan.document.clips.find(item=>item.id===id)!;
  await draw(plan,[0,10]);
  expect(received.telop).toHaveLength(2);expect(received.image).toHaveLength(2);expect(received.title).toHaveLength(2);
  const [telop,again]=received.telop as [Record<string,any>,Record<string,any>];
  expect(telop.extra instanceof Object).toBe(true);expect(telop.extra.words instanceof Array).toBe(true);expect(telop.extra).toEqual({words:['自','作']});
  expect(again.extra).toBe(telop.extra);
  const [image,imageAgain]=received.image as [Record<string,any>,Record<string,any>];
  expect(image.enter instanceof Object).toBe(true);expect(image.enter).toEqual({kind:'fade',frames:6});expect(imageAgain.enter).toBe(image.enter);
  const [title,titleAgain]=received.title as [Record<string,any>,Record<string,any>];
  expect(title.titleStyle instanceof Object).toBe(true);expect(title.titleStyle).toEqual({top:20,left:15,fontSize:24});expect(titleAgain.titleStyle).toBe(title.titleStyle);
  expect(title.titles[0].extra.lines instanceof Array).toBe(true);expect(titleAgain.titles[0].extra).toBe(title.titles[0].extra);
  // 複製は部品へ渡す分だけ。計画の文書は親の物のまま（共有の効果を保つ）で、複製も変更不可のまま。
  expect(clip('telop').content instanceof Object).toBe(false);expect(Object.isFrozen(telop.extra.words)).toBe(true);expect(Object.isFrozen(image.enter)).toBe(true);
});
it('passes this page\'s own plan data through without copying (書き出し・外からの文書)',async()=>{
  const plan=new ScenePlan(source()),clip=(id:string)=>plan.document.clips.find(item=>item.id===id)!;
  await draw(plan,[0]);
  const content=clip('telop').content,title=clip('title').content;
  expect(received.telop[0]!.extra).toBe(content.kind==='telop'?(content.data as unknown as {extra:unknown}).extra:undefined);
  expect(received.image[0]!.enter).toBe(clip('image').visual!.enter);expect(received.title[0]!.titleStyle).toBe(title.kind==='title'?title.style:undefined);
});
