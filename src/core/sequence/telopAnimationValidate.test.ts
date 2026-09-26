import {expect,it} from 'vitest';
import {fixture} from './fixtures';
import {validateSequenceDocument} from './validate';
import {BUILTIN_TELOP_ANIMATION_IDS,TELOP_ANIMATION_IDS} from '../types';

const withAnimation=(animation:unknown)=>{
  const doc=structuredClone(fixture());
  const telop=doc.clips.find(clip=>clip.id==='telop')!;
  if(telop.content.kind!=='telop')throw new Error('fixture の字幕が変わっています');
  (telop.content.data as Record<string,unknown>).animation=animation;
  return doc;
};

it('17 種はすべて受理する',()=>{
  for(const id of TELOP_ANIMATION_IDS)expect(()=>validateSequenceDocument(withAnimation(id))).not.toThrow();
});
it('未指定は受理する',()=>{
  expect(()=>validateSequenceDocument(fixture())).not.toThrow();
});
it('17 種の外は拒否する',()=>{
  for(const bad of ['slideOut','',null,7])
    expect(()=>validateSequenceDocument(withAnimation(bad))).toThrow(/字幕のアニメーションが不正です/);
});
it('旧 9 種を持つ旧文書はそのまま通る（後方互換）',()=>{
  for(const id of BUILTIN_TELOP_ANIMATION_IDS)expect(()=>validateSequenceDocument(withAnimation(id))).not.toThrow();
});

it('import origin は受理する（role: music|effect）',()=>{
  const doc=structuredClone(fixture());
  const asset=doc.assets[0]!;
  asset.origin={kind:'import',role:'music'};
  expect(()=>validateSequenceDocument(doc)).not.toThrow();
  asset.origin={kind:'import',role:'effect'};
  expect(()=>validateSequenceDocument(doc)).not.toThrow();
});

it('import origin で role が不正なら拒否',()=>{
  const doc=structuredClone(fixture());
  const asset=doc.assets[0]!;
  asset.origin={kind:'import',role:'x' as unknown as 'music'|'effect'};
  expect(()=>validateSequenceDocument(doc)).toThrow(/素材の由来が不正です/);
});

it('audio-fix origin は現状どおり検査',()=>{
  const doc=structuredClone(fixture());
  const asset=doc.assets[0]!;
  asset.origin={kind:'audio-fix',from:'other',fix:'denoise'};
  expect(()=>validateSequenceDocument(doc)).not.toThrow();
  asset.origin={kind:'audio-fix',from:'other',fix:'bad' as unknown as 'denoise'|'normalize'};
  expect(()=>validateSequenceDocument(doc)).toThrow(/素材の由来が不正です/);
});
