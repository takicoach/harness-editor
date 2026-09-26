import {expect,it} from 'vitest';
import {textStylePreparation} from './textStylePreparation';
import type {SequenceAsset,SequenceClip,SequenceDocument} from '../../core/sequence/model';

const base={id:'d',resolution:{width:640,height:360},fps:{num:30,den:1},revision:1} as unknown as SequenceDocument;

function telopClip(componentAssetId?:string):SequenceClip {
  return {id:'c1',name:'text',content:{kind:'telop',componentAssetId,data:{text:'x',template:1}}} as unknown as SequenceClip;
}
function componentAsset(id:string,catalog:boolean):SequenceAsset {
  return {id,kind:'component',name:id,file:`${id}.mjs`,fingerprint:'f',streams:[],
    ...(catalog?{textStyleCatalog:{source:'builtin' as const,packId:'p',version:'1',componentHash:'aaaaaaaaaaaaaaaa',entries:[{id:1,name:'a'}]}}:{})} as unknown as SequenceAsset;
}

it('needs-builtin when no builtin catalog asset exists',()=>{
  const doc={...base,clips:[],assets:[]} as SequenceDocument;
  expect(textStylePreparation(doc)).toBe('needs-builtin');
});

it('needs-project when a builtin catalog exists but the referenced component asset has none',()=>{
  const doc={...base,clips:[telopClip('project-asset')],
    assets:[componentAsset('builtin-asset',true),componentAsset('project-asset',false)]} as SequenceDocument;
  expect(textStylePreparation(doc)).toBe('needs-project');
});

it('ready when a builtin catalog exists and every referenced component asset has a catalog',()=>{
  const doc={...base,clips:[telopClip('builtin-asset')],
    assets:[componentAsset('builtin-asset',true)]} as SequenceDocument;
  expect(textStylePreparation(doc)).toBe('ready');
});
