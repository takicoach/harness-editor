import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import type {SequenceDocument} from './model';
import {rational as r} from './time';

function doc():SequenceDocument{
  const telop=(id:string,template:number,startFrame:number)=>({id,trackId:'t',name:id,startFrame,durationFrames:30,
    clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop' as const,data:{text:id,template},componentAssetId:'pack'}});
  return {schemaVersion:2,id:'d',name:'n',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:60,background:'#000',
    assets:[{id:'pack',kind:'component',name:'テロップスタイル',file:'a.mjs',fingerprint:'f',streams:[],
      textStyleCatalog:{source:'builtin',packId:'editor-telop',version:'1',componentHash:'aaaaaaaaaaaaaaaa',entries:[{id:1,name:'A'},{id:2,name:'B'}]}}],
    transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'t',kind:'visual',name:'t',enabled:true},
      {id:'u',kind:'visual',name:'u',enabled:true}],
    clips:[telop('a',1,0),telop('b',2,30),{id:'c',trackId:'u',name:'タイトル',startFrame:0,durationFrames:30,
      clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'title',data:{text:'t'},style:{top:0,left:0,fontSize:40}}}]} as SequenceDocument;
}

it('applies one style to every telop clip in a single command',()=>{
  const next=applySequenceCommand(doc(),{type:'apply-text-style-all',assetId:'pack',styleId:2});
  expect(next.clips.filter(c=>c.content.kind==='telop').map(c=>c.content.kind==='telop'?c.content.data.template:null)).toEqual([2,2]);
  expect(next.clips.filter(c=>c.content.kind==='telop').every(c=>c.content.kind==='telop'&&c.content.textMode==='component')).toBe(true);
});
it('never touches title clips',()=>{
  const before=doc(),next=applySequenceCommand(before,{type:'apply-text-style-all',assetId:'pack',styleId:2});
  expect(next.clips.find(c=>c.id==='c')).toEqual(before.clips.find(c=>c.id==='c'));
});
it('rejects a style id the catalog does not declare, leaving the document untouched',()=>{
  const before=doc();
  expect(()=>applySequenceCommand(before,{type:'apply-text-style-all',assetId:'pack',styleId:99})).toThrow();
  expect(before).toEqual(doc());
});
it('stores and replaces the hidden list per component asset',()=>{
  let next=applySequenceCommand(doc(),{type:'set-text-style-hidden',assetId:'pack',hidden:[2]});
  expect(next.textStylePrefs).toEqual({hidden:{pack:[2]}});
  next=applySequenceCommand(next,{type:'set-text-style-hidden',assetId:'pack',hidden:[]});
  expect(next.textStylePrefs).toEqual({hidden:{pack:[]}});
});

it('keeps imported title telops on other tracks unchanged, including size and animation',()=>{
  const before=doc();
  const heading=structuredClone(before.clips[0]!);
  heading.id='heading';heading.trackId='heading-track';
  before.tracks.push({id:'heading-track',kind:'visual',name:'章タイトル',enabled:true});
  if(heading.content.kind!=='telop')throw new Error('fixture');
  heading.content.data.scale=0.65;heading.content.data.animation='charByChar';
  before.clips.push(heading);
  const next=applySequenceCommand(before,{type:'apply-text-style-all',assetId:'pack',styleId:2,trackId:'t',clearUnsupportedAnimations:true});
  expect(next.clips.find(c=>c.id==='heading')).toEqual(heading);
  expect(next.clips.find(c=>c.id==='c')).toEqual(before.clips.find(c=>c.id==='c'));
  expect(next.clips.filter(c=>c.trackId==='t').every(c=>c.content.kind==='telop'&&c.content.data.template===2)).toBe(true);
});
