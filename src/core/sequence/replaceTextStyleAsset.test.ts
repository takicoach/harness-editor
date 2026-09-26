import {expect,it} from 'vitest';
import {fixture} from './fixtures';
import {applySequenceCommand} from './commands';
import type {SequenceAsset,SequenceDocument} from './model';

const component=(id:string):SequenceAsset=>({id,kind:'component',file:`.harness/assets/${id}.js`,name:id,fingerprint:id.padEnd(64,'0'),streams:[],
  textStyleCatalog:{source:'project',entries:[{id:1,name:'標準'}],animations:['none']}});

function twoComponents():SequenceDocument {
  const doc=structuredClone(fixture());
  doc.assets.push(component('old'),component('new'));
  doc.rendering={telopComponentAssetId:'old',telopBottomOffset:null,telopFontSize:null};
  const telop=doc.clips.find(clip=>clip.id==='telop')!;
  if(telop.content.kind!=='telop')throw new Error('fixture の字幕が変わっています');
  telop.content.textMode='component';
  return doc;
}

it('旧部品を使う字幕を全部新しい部品へ向け直し、旧資産は残す',()=>{
  const before=twoComponents();
  const after=applySequenceCommand(before,{type:'replace-text-style-asset',fromAssetId:'old',toAssetId:'new'});
  const telop=after.clips.find(clip=>clip.id==='telop')!;
  expect(telop.content.kind==='telop'&&telop.content.componentAssetId).toBe('new');
  expect(after.assets.some(asset=>asset.id==='old')).toBe(true);
  expect(after.rendering?.telopComponentAssetId).toBe('old');
  expect(before.clips.find(clip=>clip.id==='telop')!.content).toEqual(twoComponents().clips.find(clip=>clip.id==='telop')!.content);
});
it('切替先が描画部品でなければ拒否する',()=>{
  const doc=twoComponents();
  expect(()=>applySequenceCommand(doc,{type:'replace-text-style-asset',fromAssetId:'old',toAssetId:'source'})).toThrow(/描画部品/);
});
it('切り替える字幕が 1 件も無ければ拒否する（無変化の成功にしない）',()=>{
  const doc=twoComponents();
  expect(()=>applySequenceCommand(doc,{type:'replace-text-style-asset',fromAssetId:'new',toAssetId:'old'})).toThrow(/切り替える字幕/);
});

it('切替先が textStyleCatalog を持たなければ拒否',()=>{
  const doc=twoComponents();
  const noCatalogAsset=doc.assets.find(a=>a.id==='new')!;
  delete noCatalogAsset.textStyleCatalog;
  expect(()=>applySequenceCommand(doc,{type:'replace-text-style-asset',fromAssetId:'old',toAssetId:'new'})).toThrow(/カタログがありません/);
});
