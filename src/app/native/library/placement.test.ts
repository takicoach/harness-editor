import {describe,expect,it} from 'vitest';
import type {SequenceAsset,SequenceDocument,SequenceClip} from '../../../core/sequence/model';
import {fixture} from '../../../core/sequence/fixtures';
import {rational} from '../../../core/sequence/time';
import type {LibraryCatalog,LibraryMedia,LibraryTemplate} from './libraryApi';
import {buildLibraryPlacement,buildMediaPlacement,findLibraryTarget,MOTION_TRACK_NAME} from './placement';

const ids=()=>{let n=0;return ()=>`id${++n}`;};
const withFps=(num:number,den=1):SequenceDocument=>({...fixture(),fps:rational(num,den)});
const tpl:LibraryTemplate={key:'p:38',packId:'p',template:38,name:'ポップ',group:'g',use:'',preview:'a.png',sample:'見本',durationSec:7};
const component:SequenceAsset={id:'comp',kind:'component',file:'c.mjs',name:'部品',fingerprint:'f',streams:[],textStyleCatalog:{source:'installed',entries:[{id:38,name:'ポップ'}]}};
const audioAsset=(duration=4):SequenceAsset=>({id:'snd',kind:'media',file:'snd.wav',name:'音',fingerprint:'s',streams:[{index:0,kind:'audio',codec:'pcm',duration:rational(duration),sampleRate:48000,channels:2}]});
const imageAsset:SequenceAsset={id:'img',kind:'image',file:'i.png',name:'画像',fingerprint:'i',streams:[]};
const media=(kind:LibraryMedia['kind'],gainDb?:number):LibraryMedia=>({key:`m:${kind}`,kind,name:'素材',desc:'',file:'f',fingerprint:'x'.repeat(64),...(gainDb!==undefined?{gainDb}:{})});
const inserted=(r:ReturnType<typeof buildLibraryPlacement>)=>{if('error' in r)throw new Error(r.error);const i=r.commands.find(c=>c.type==='insert');if(!i||i.type!=='insert')throw new Error('no insert');return i.clips;};
const addTrack=(r:ReturnType<typeof buildLibraryPlacement>)=>{if('error' in r)throw new Error(r.error);const c=r.commands.find(c=>c.type==='add-track');return c&&c.type==='add-track'?c:undefined;};
const place=(doc:SequenceDocument,tracks:Array<{id:string;name:string;enabled?:boolean}>)=>({...doc,tracks:[...doc.tracks,...tracks.map(t=>({id:t.id,kind:'visual' as const,name:t.name,enabled:t.enabled??true}))]});
const clipOn=(trackId:string,start:number,dur:number):SequenceClip=>({id:`c-${trackId}`,name:'x',trackId,startFrame:start,durationFrames:dur,clock:{offset:rational(0),rate:rational(1),duration:rational(dur)},content:{kind:'telop',data:{text:'a'}}});

describe('buildLibraryPlacement',()=>{
  it('places a motion template with sample text and fps-converted length on a new motion track',()=>{
    const r=buildLibraryPlacement(withFps(30000,1001),component,{kind:'template',item:tpl},100,undefined,ids());
    expect(inserted(r)[0]).toMatchObject({startFrame:100,durationFrames:210,clock:{duration:rational(210)},anchor:{kind:'timeline'},
      content:{kind:'telop',textMode:'component',componentAssetId:'comp',data:{animation:'none',template:38,text:'見本'}},
      visual:{opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}});
    expect((inserted(r)[0]!.content as {data:Record<string,unknown>}).data).not.toHaveProperty('scale');
    expect((inserted(r)[0]!.content as {data:Record<string,unknown>}).data).not.toHaveProperty('position');
    expect(addTrack(r)?.track.name).toBe(MOTION_TRACK_NAME);
    expect(addTrack(r)?.track.kind).toBe('visual');
  });
  it('keeps the same seconds on a 60 fps project and never goes below 1 frame',()=>{
    expect(inserted(buildLibraryPlacement(withFps(60),component,{kind:'template',item:tpl},0,undefined,ids()))[0]!.durationFrames).toBe(420);
    expect(inserted(buildLibraryPlacement(withFps(60),component,{kind:'template',item:{...tpl,durationSec:0.001}},0,undefined,ids()))[0]!.durationFrames).toBe(1);
  });
  it('reuses an enabled, free, non-fade motion track and skips disabled or busy ones',()=>{
    const target={kind:'template' as const,item:tpl};
    const reuse=buildLibraryPlacement(place(fixture(),[{id:'m1',name:MOTION_TRACK_NAME}]),component,target,10,undefined,ids());
    expect(addTrack(reuse)).toBeUndefined();expect(inserted(reuse)[0]!.trackId).toBe('m1');
    const off=buildLibraryPlacement(place(fixture(),[{id:'m1',name:MOTION_TRACK_NAME,enabled:false}]),component,target,10,undefined,ids());
    expect(addTrack(off)?.track.name).toBe(MOTION_TRACK_NAME);
    const busyDoc={...place(fixture(),[{id:'m1',name:MOTION_TRACK_NAME}]),clips:[...fixture().clips,clipOn('m1',50,100)]};
    const busy=buildLibraryPlacement(busyDoc,component,target,10,undefined,ids());
    expect(addTrack(busy)).toBeDefined();expect(inserted(busy)[0]!.trackId).not.toBe('m1');
    const fadeDoc={...place(fixture(),[{id:'m1',name:MOTION_TRACK_NAME}]),clips:[...fixture().clips,{...clipOn('m1',500,10),content:{kind:'scene-fade'}} as unknown as SequenceClip]};
    expect(addTrack(buildLibraryPlacement(fadeDoc,component,target,10,undefined,ids()))).toBeDefined();
  });
  it('refuses a template that the component catalog does not list',()=>{
    expect(buildLibraryPlacement(fixture(),component,{kind:'template',item:{...tpl,template:99}},0)).toEqual({error:'このモーションは部品の一覧にありません'});
    expect(buildLibraryPlacement(fixture(),audioAsset(),{kind:'template',item:tpl},0)).toHaveProperty('error');
  });
  it('places a sound effect with role effect, no loop and the library gain (default -10)',()=>{
    const c=inserted(buildLibraryPlacement(fixture(),audioAsset(),{kind:'media',item:media('se')},30,undefined,ids()))[0]!;
    expect(c.content).toMatchObject({kind:'audio',role:'effect',loop:false,settings:{gainDb:-10}});
    const g=inserted(buildLibraryPlacement(fixture(),audioAsset(),{kind:'media',item:media('se',-4)},30,undefined,ids()))[0]!;
    expect(g.content).toMatchObject({settings:{gainDb:-4}});
  });
  it('places BGM with role music, loop and -15 dB by default',()=>{
    const c=inserted(buildLibraryPlacement(fixture(),audioAsset(),{kind:'media',item:media('bgm')},0,undefined,ids()))[0]!;
    expect(c.content).toMatchObject({kind:'audio',role:'music',loop:true,settings:{gainDb:-15}});
    expect(inserted(buildLibraryPlacement(fixture(),audioAsset(),{kind:'media',item:media('bgm',-20)},0,undefined,ids()))[0]!.content).toMatchObject({settings:{gainDb:-20}});
  });
  it('places an image on a visual track like insertAsset',()=>{
    const r=buildLibraryPlacement(fixture(),imageAsset,{kind:'media',item:media('image')},300,undefined,ids());
    expect(inserted(r)[0]).toMatchObject({trackId:'v1',startFrame:300,durationFrames:150,content:{kind:'image',assetId:'img',style:'plain'}});
  });
  it('uses the dropped track when it fits and falls back otherwise',()=>{
    const target={kind:'template' as const,item:tpl};
    const doc=place(fixture(),[{id:'free',name:'自分の段'}]);
    expect(inserted(buildLibraryPlacement(doc,component,target,10,'free',ids()))[0]!.trackId).toBe('free');
    expect(addTrack(buildLibraryPlacement(doc,component,target,10,'a1',ids()))?.track.name).toBe(MOTION_TRACK_NAME);
    expect(inserted(buildLibraryPlacement(fixture(),audioAsset(),{kind:'media',item:media('se')},0,'a2',ids()))[0]!.trackId).toBe('a2');
  });
  it('refuses a media drop on a scene-fade track like insertAsset',()=>{
    const doc={...place(fixture(),[{id:'sf',name:'フェード'}]),clips:[...fixture().clips,{...clipOn('sf',0,10),content:{kind:'scene-fade'}} as unknown as SequenceClip]};
    expect(buildLibraryPlacement(doc,imageAsset,{kind:'media',item:media('image')},0,'sf')).toEqual({error:'場面フェードのトラックです。映像または音声のトラックを選んでください。'});
  });
});

describe('buildMediaPlacement (insertAsset の既存規則)',()=>{
  it('keeps the legacy video+audio shape: linked clips, speech role, no override',()=>{
    const doc=fixture(),video=doc.assets[0]!;
    const r=buildMediaPlacement(doc,video,300,undefined,{},ids());
    if('error' in r)throw new Error(r.error);
    const clips=(r.commands.at(-1) as {clips:SequenceClip[]}).clips;
    expect(clips).toHaveLength(2);expect(clips[0]!.linkGroupId).toBe(clips[1]!.linkGroupId);
    expect(clips[0]!.content).toMatchObject({kind:'video',streamIndex:0});
    expect(clips[1]!.content).toMatchObject({kind:'audio',role:'speech',loop:false,settings:{gainDb:0}});
    expect(r.selectId).toBe(clips[0]!.id);
  });
  it('keeps the legacy role rules: music -18 dB, effect no loop, audio-only defaults to music loop',()=>{
    const at=(role?:'music'|'effect')=>{const r=buildMediaPlacement(fixture(),audioAsset(),0,undefined,{role},ids());if('error' in r)throw new Error(r.error);return (r.commands.at(-1) as {clips:SequenceClip[]}).clips[0]!.content;};
    expect(at('music')).toMatchObject({role:'music',loop:true,settings:{gainDb:-18}});
    expect(at('effect')).toMatchObject({role:'effect',loop:false,settings:{gainDb:0}});
    expect(at(undefined)).toMatchObject({role:'music',loop:true,settings:{gainDb:0}});
  });
});

describe('findLibraryTarget',()=>{
  const catalog:LibraryCatalog={version:2,packs:[],templates:[tpl],media:[media('se')]};
  it('finds templates and media by key, null otherwise',()=>{
    expect(findLibraryTarget(catalog,'p:38')?.kind).toBe('template');
    expect(findLibraryTarget(catalog,'m:se')?.kind).toBe('media');
    expect(findLibraryTarget(catalog,'zzz')).toBeNull();
  });
});
