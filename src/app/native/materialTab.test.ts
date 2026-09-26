import {expect,it} from 'vitest';
import {fixture} from '../../core/sequence/fixtures';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {MATERIAL_TAB_EMPTY,materialTabItems,materialTabOf} from './materialTab';

const audio=(over:Partial<SequenceAsset>={}):SequenceAsset=>({id:'a',kind:'media',file:'.harness/assets/a.m4a',name:'音',fingerprint:'a'.repeat(64),
  streams:[{index:0,kind:'audio',codec:'aac',duration:r(30),sampleRate:48000,channels:2}],...over});
const doc=():SequenceDocument=>structuredClone(fixture());

it('規則 1: LUT',()=>{
  expect(materialTabOf(doc(),{id:'l',kind:'lut',file:'public/lut/a.cube',name:'L',fingerprint:'l'.repeat(64),streams:[]})).toBe('lut');
});
it('規則 2: 画像',()=>{
  expect(materialTabOf(doc(),{id:'i',kind:'image',file:'public/i.png',name:'I',fingerprint:'i'.repeat(64),streams:[]})).toBe('image');
});
it('規則 3: 映像ストリームを持つ',()=>{
  expect(materialTabOf(doc(),doc().assets[0]!)).toBe('video');
});
it('規則 4: 原音の補正結果は元の映像と同じ場所へ',()=>{
  expect(materialTabOf(doc(),audio({origin:{kind:'audio-fix',from:'source',fix:'denoise'}}))).toBe('video');
});
it('規則 5: 取り込み時の種類で確定する',()=>{
  expect(materialTabOf(doc(),audio({origin:{kind:'import',role:'effect'}}))).toBe('se');
  expect(materialTabOf(doc(),audio({origin:{kind:'import',role:'music'}}))).toBe('bgm');
});
it('規則 6: 記録が無くても文書のクリップの role で救う',()=>{
  const document=doc();
  expect(materialTabOf(document,audio({id:'source'}))).toBe('video');   // 'audio' クリップが role:'speech'
  const music=doc();
  music.clips=music.clips.filter(clip=>clip.id==='music');
  expect(materialTabOf(music,audio({id:'source'}))).toBe('bgm');
  const effect=doc();
  effect.clips=effect.clips.filter(clip=>clip.id==='music');
  const target=effect.clips[0]!;if(target.content.kind==='audio')target.content.role='effect';
  expect(materialTabOf(effect,audio({id:'source'}))).toBe('se');
});
it('規則 7: 未使用かつ記録なしはパスで分ける',()=>{
  expect(materialTabOf(doc(),audio({id:'lonely',file:'public/se/clap.mp3'}))).toBe('se');
  expect(materialTabOf(doc(),audio({id:'lonely',file:'public/BGM/theme.mp3'}))).toBe('bgm');
});
it('タブは 4 件で、ラベルは名前＋件数（0 でも出す）',()=>{
  const document=doc();
  const items=materialTabItems(document,document.assets);
  expect(items.map(item=>item.value)).toEqual(['video','image','bgm','se']);
  expect(items.map(item=>item.label)).toEqual(['動画 1','画像 0','BGM 0','効果音 0']);
});
it('空タブの文言を 4 件持つ',()=>{
  expect(MATERIAL_TAB_EMPTY.bgm).toBe('BGM がありません。「＋ BGM を追加」で読み込みます。');
  expect(Object.keys(MATERIAL_TAB_EMPTY)).toEqual(['video','image','bgm','se']);
});
