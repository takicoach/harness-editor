import {expect,it} from 'vitest';
import {cutSourceExtent,cutSourceOwners,cutSourceReview,sourceToCutLocal} from './cutSourceReview';
import type {SequenceDocument,SequenceClip} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
function fixture():SequenceDocument{
  const clip:SequenceClip={id:'first-use',name:'最初の使用箇所',trackId:'v',startFrame:10,durationFrames:30,clock:{offset:r(20),rate:r(2),duration:r(500)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(3),rate:r(2)}};
  return {schemaVersion:2,id:'edit',name:'原本確認',revision:9,fps:r(30),resolution:{width:1280,height:720},sequenceEndFrame:0,background:'#000000',tracks:[{id:'v',kind:'visual',name:'映像',enabled:true}],clips:[],transcripts:[],transitions:[],ducking:{enabled:true,strength:'mid'},
    assets:[{id:'asset',kind:'media',file:'source.mp4',name:'素材',fingerprint:'fixture',streams:[{index:0,kind:'video',codec:'h264',duration:r(12),frameRate:r(60),width:640,height:360},{index:1,kind:'audio',codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
    cutArchive:{version:1,entries:[{id:'cut',durationFrames:80,completionFloorFrames:80,origin:{cutId:'cut',startFrame:0,endFrame:80},boundary:{hintFrame:0,ambiguous:true,references:[]},tracks:[{id:'v',kind:'visual',name:'映像',enabled:true}],clips:[clip,{...structuredClone(clip),id:'second-use',name:'同じ素材の別使用',startFrame:50}]}]}};
}
it('auditions the entire raw source at one speed with separate FPS and no edit settings or mutation',()=>{
  const doc=fixture(),before=structuredClone(doc),preview=cutSourceReview(doc,'cut','first-use');
  expect(preview.sequenceEndFrame).toBe(720);expect(preview.fps).toEqual(r(60));expect(preview.resolution).toEqual({width:640,height:360});
  expect(preview.cutArchive).toBeUndefined();expect(preview.speed).toBeUndefined();expect(preview.transitions).toEqual([]);expect(preview.ducking.enabled).toBe(false);
  for(const clip of preview.clips){expect(clip.content).toMatchObject({sourceIn:r(0),rate:r(1)});expect(clip.durationFrames).toBe(720);}
  expect(doc).toEqual(before);preview.assets[0]!.name='確認だけの変更';expect(doc.assets[0]!.name).toBe('素材');
});
it('keeps repeated source occurrences distinct and maps through their saved speed and local placement',()=>{
  const doc=fixture(),owners=cutSourceOwners(doc,'cut');expect(owners.map(c=>c.id)).toEqual(['first-use','second-use']);
  expect(cutSourceExtent(owners[0]!,doc.fps)).toEqual({start:r(3),end:r(5)});
  expect(sourceToCutLocal(owners[0]!,r(4),doc.fps)).toEqual(r(25));
  expect(sourceToCutLocal(owners[1]!,r(4),doc.fps)).toEqual(r(65));
  expect(sourceToCutLocal(owners[0]!,r(7,2),doc.fps)).toEqual(r(35,2));
});
it('uses the chosen audio stream and source rotation, and rejects missing ownership instead of another occurrence',()=>{
  const doc=fixture(),entry=doc.cutArchive!.entries[0]!;
  doc.assets[0]!.streams[0]!.rotation=90;
  entry.clips.push({id:'audio-use',name:'原音',trackId:'a',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(2),rate:r(1),role:'speech',loop:false,settings:{gainDb:-12,muted:true,fadeInFrames:2,fadeOutFrames:2}}});
  const preview=cutSourceReview(doc,'cut','audio-use');expect(preview.sequenceEndFrame).toBe(600);expect(preview.resolution).toEqual({width:360,height:640});expect(preview.clips.find(c=>c.content.kind==='audio')!.content).toMatchObject({streamIndex:1,settings:{gainDb:0,muted:false}});
  expect(()=>cutSourceReview(doc,'missing','first-use')).toThrow('使用箇所');expect(()=>cutSourceReview(doc,'cut','missing')).toThrow('使用箇所');
});
