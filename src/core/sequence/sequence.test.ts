import { describe, expect, it } from 'vitest';
import { applySequenceCommand } from './commands';
import { clipEnd, DEFAULT_TEXT_APPEARANCE, effectFrameAt, sourceTimeAt, type SequenceClip, type SequenceDocument } from './model';
import { addTime, compareTime, divideTime, floorTime, frameSeconds, multiplyTime, rational as r, rationalFromDecimal } from './time';
import { parseSequence, sequenceContentBytes, serializeSequence, validateSequenceDocument } from './validate';
import { SequenceSession } from './session';
import { speechSelectionRange } from './sourceSelection';
import { ScenePlan } from './scenePlan';
import { mixAudioBlock, pcmKey } from '../../preview/native/audioMixer';
import { DEFAULT_MAIN_LAYOUT } from '../mainLayout';
import { createScriptDocument } from '../scriptDocumentData';
import { sourceReviewDocument } from './sourceReview';
import {activeTextAppearance,textComponentId,withTextMode} from './textStyle';
import {telopClipsLosingAnimation} from './telopAnimationSupport';
import {keyframeTimelineTime,punchVisualKeyframe,sampleVisualTransform,visualKeyframeTime} from './visualTransform';

import { fixture } from './fixtures';
export { fixture };
function clip(doc: SequenceDocument, id: string): SequenceClip { return doc.clips.find(c => c.id === id)!; }
it('removes only an empty track while preserving every clip, asset and timeline frame',()=>{
  const doc=fixture();doc.tracks.push({id:'empty',name:'不要な映像',kind:'visual',enabled:true});
  const before=structuredClone(doc),next=applySequenceCommand(doc,{type:'remove-track',trackId:'empty'} as never);
  expect(next.tracks.map(t=>t.id)).toEqual(before.tracks.filter(t=>t.id!=='empty').map(t=>t.id));
  expect(next.clips).toEqual(before.clips);expect(next.assets).toEqual(before.assets);
  expect(next.sequenceEndFrame).toBe(before.sequenceEndFrame);expect(doc).toEqual(before);
});
it('rejects removing an occupied or missing track without deleting linked media',()=>{
  const doc=fixture(),before=structuredClone(doc);
  expect(()=>applySequenceCommand(doc,{type:'remove-track',trackId:'v1'} as never)).toThrow('クリップ');
  expect(()=>applySequenceCommand(doc,{type:'remove-track',trackId:'missing'} as never)).toThrow('トラック');
  expect(doc).toEqual(before);
});
it.each([{scale:'large'},{scale:0},{rotation:'left'},{position:{x:0}},{position:{x:'left',y:0}},{flipH:1},{flipV:null},{opacity:1.1},{opacity:'transparent'}])('rejects malformed position-key values before rendering: %j',value=>{
  const doc=fixture();clip(doc,'video').visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[{frame:r(0),value:value as never}]};
  expect(()=>validateSequenceDocument(doc)).toThrow('キーフレームの値が不正です');
});
it('captures current position and opacity without duplicating a fractional key time',()=>{
  const item=clip(fixture(),'video');item.clock={offset:r(1,3),rate:r(2,3),duration:r(300)};
  item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.8,keyframes:[],motion:{preset:'fadeIn'}};
  const before=sampleVisualTransform(item,10),visual=punchVisualKeyframe(item,10),next={...item,visual};
  expect(visual.keyframes[0]!.frame).toEqual(r(7));expect(keyframeTimelineTime(next,r(7))).toEqual(r(10));
  expect(sampleVisualTransform(next,10)).toEqual(before);expect(visual.motion).toEqual(item.visual.motion);
  expect(punchVisualKeyframe(next,10).keyframes).toEqual(visual.keyframes);
  expect(()=>punchVisualKeyframe(item,300)).toThrow('選択したクリップの再生位置に移動してください');
});
it('renders an exact wide key clock without rounding its boundary or overflowing its stored time',()=>{
  const doc=fixture(),item=clip(doc,'video');
  item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframeClock:{offset:r(1,Number.MAX_SAFE_INTEGER),rate:r(1,2),duration:r(300)},keyframes:[
    {frame:r(0),value:{scale:1}},{frame:r(1),value:{scale:3}},
  ]};
  validateSequenceDocument(doc);
  const at=()=>new ScenePlan(doc).frame(1).visuals.find(value=>value.clip.id===item.id)!.transform.scale;
  expect(at()).toBeCloseTo(2,12);
  // 1/2 + 1/MAX is strictly past this point even when its stored sum cannot fit.
  item.visual.keyframesOutside='base';item.visual.keyframes=[{frame:r(1,2),value:{scale:3}}];
  expect(at()).toBe(1);
  item.visual.keyframeClock!.rate=r(2);item.visual.keyframes=[{frame:r(2),value:{scale:3}}];
  expect(2+1/Number.MAX_SAFE_INTEGER).toBe(2); // Numeric comparison would incorrectly include this point.
  validateSequenceDocument(doc);expect(at()).toBe(1);
  item.visual.keyframes=[];expect(at()).toBe(1);
  expect(()=>punchVisualKeyframe(item,1)).toThrow('時刻の精度を保てる範囲を超えています');
});

it('preserves the effective easing when recapturing duplicate position keys',()=>{
  const doc=fixture(),item=clip(doc,'video');
  item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[
    {frame:r(0),value:{scale:1},easing:'linear'},
    {frame:r(0),value:{scale:1},easing:'easeInOut'},
    {frame:r(10),value:{scale:3}},
  ]};
  validateSequenceDocument(doc);
  const before=Array.from({length:11},(_,frame)=>sampleVisualTransform(item,frame));
  expect(before[2]!.scale).toBeCloseTo(1.064,12);
  item.visual=punchVisualKeyframe(item,0);
  expect(item.visual.keyframes).toHaveLength(3);
  expect(item.visual.keyframes[1]!.easing).toBe('easeInOut');
  expect(Array.from({length:11},(_,frame)=>sampleVisualTransform(item,frame))).toEqual(before);
});
it.each([0,10,20])('preserves both sides of duplicate keys when recapturing frame %i',frame=>{
  const doc=fixture(),item=clip(doc,'video');
  item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[
    ...(frame>0?[{frame:r(0),value:{scale:1}}]:[]),
    {frame:r(frame),value:{scale:3},easing:'linear'},
    {frame:r(frame),value:{scale:5},easing:'easeInOut'},
    ...(frame<20?[{frame:r(20),value:{scale:7}}]:[]),
  ]};
  validateSequenceDocument(doc);
  const original=structuredClone(item.visual.keyframes),before=Array.from({length:22},(_,at)=>sampleVisualTransform(item,at));
  item.visual=punchVisualKeyframe(item,frame);
  expect(item.visual.keyframes).toHaveLength(original.length);
  expect(item.visual.keyframes.filter(key=>compareTime(key.frame,r(frame))===0)[0]).toEqual(original.find(key=>compareTime(key.frame,r(frame))===0));
  expect(Array.from({length:22},(_,at)=>sampleVisualTransform(item,at))).toEqual(before);
});
describe.each(['dedicated','clip'] as const)('exact position-key evaluation on the %s clock',clockKind=>{
  function setClock(item:SequenceClip,offset:ReturnType<typeof r>,rate:ReturnType<typeof r>){
    const clock={offset,rate,duration:r(300)};
    if(clockKind==='dedicated')item.visual!.keyframeClock=clock;else item.clock=clock;
  }
  it.each([
    {offset:r(1,10),rate:r(1,5),keyTime:r(3,10),outside:'base' as const},
    {offset:r(1,10),rate:r(1,5),keyTime:r(3,10),outside:'hold' as const},
    {offset:r(7,10),rate:r(1,10),keyTime:r(4,5),outside:'base' as const},
    {offset:r(7,10),rate:r(1,10),keyTime:r(4,5),outside:'hold' as const},
  ])('renders an edited fractional point and its outside policy: %j',({offset,rate,keyTime,outside})=>{
    const doc=fixture(),item=clip(doc,'video');
    item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.8,keyframes:[],keyframesOutside:outside,motion:{preset:'fadeIn'}};
    setClock(item,offset,rate);
    const before=[sampleVisualTransform(item,0),sampleVisualTransform(item,2)];
    item.visual=punchVisualKeyframe(item,1);
    expect(item.visual.keyframes[0]!.frame).toEqual(keyTime);
    expect(keyframeTimelineTime(item,keyTime)).toEqual(r(1));
    item.visual.keyframes[0]!.value={scale:3,opacity:.4,flipH:true};
    validateSequenceDocument(doc);
    const plan=new ScenePlan(doc),at=(frame:number)=>plan.frame(frame).visuals.find(v=>v.clip.id===item.id)!.transform;
    expect(at(1)).toMatchObject({scale:3,opacity:.4,flipH:true});
    for(const [index,frame] of [0,2].entries()){
      if(outside==='base')expect(at(frame)).toEqual(before[index]);
      else expect(at(frame)).toMatchObject({scale:3,opacity:.4,flipH:true});
    }
    expect(item.visual.motion).toEqual({preset:'fadeIn'});
  });
  it.each(['linear','easeInOut'] as const)('retains the exact interpolation fraction before applying %s easing',easing=>{
    const doc=fixture(),item=clip(doc,'video'),start=1_000_000_000_000_000;
    item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframesOutside:'base',keyframes:[
      {frame:r(start),value:{position:{x:0,y:0},scale:1,opacity:.2},easing},
      {frame:r(start+1),value:{position:{x:.27,y:.54},scale:3.7,opacity:.8}},
    ]};
    setClock(item,r(start),r(1,3));validateSequenceDocument(doc);
    const plan=new ScenePlan(doc);
    for(const [frame,progress] of [[1,easing==='linear'?1/3:4/27],[2,easing==='linear'?2/3:23/27]] as const){
      const value=plan.frame(frame).visuals.find(v=>v.clip.id===item.id)!.transform;
      expect(value.x).toBeCloseTo(.27*progress,12);expect(value.y).toBeCloseTo(.54*progress,12);
      expect(value.scale).toBeCloseTo(1+2.7*progress,12);expect(value.opacity).toBeCloseTo(.2+.6*progress,12);
    }
  });
  it.each(['base','hold'] as const)('renders validated extreme-denominator keys without overflowing intermediate differences (%s)',outside=>{
    const doc=fixture(),item=clip(doc,'video');item.startFrame=1;
    item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframesOutside:outside,keyframes:[
      {frame:r(1,Number.MAX_SAFE_INTEGER),value:{scale:1}},
      {frame:r(2),value:{scale:3}},
    ]};
    setClock(item,r(0),r(1));validateSequenceDocument(doc);
    // The exact absolute timeline time cannot fit the public safe-integer Rational type.
    expect(()=>keyframeTimelineTime(item,item.visual!.keyframes[0]!.frame)).toThrow('時刻の精度を保てる範囲を超えています');
    const plan=new ScenePlan(doc),at=(frame:number)=>plan.frame(frame).visuals.find(v=>v.clip.id===item.id)!.transform.scale;
    expect(at(1)).toBe(1);expect(at(2)).toBeCloseTo(2,12);expect(at(3)).toBe(3);expect(at(4)).toBe(outside==='base'?1:3);
  });
  it('selects the last equal-time point and the correct neighbors without rounding the clock',()=>{
    const doc=fixture(),item=clip(doc,'video');
    item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframesOutside:'base',keyframes:[
      {frame:r(4,5),value:{scale:3,flipH:false}},
      {frame:r(1),value:{scale:5,flipH:false}},
      {frame:r(0),value:{scale:1,flipH:false}},
      {frame:r(8,10),value:{scale:4,flipH:true}},
    ]};
    setClock(item,r(7,10),r(1,10));validateSequenceDocument(doc);
    const plan=new ScenePlan(doc),at=(frame:number)=>plan.frame(frame).visuals.find(v=>v.clip.id===item.id)!.transform;
    expect(at(0)).toMatchObject({scale:2.75,flipH:false});
    expect(at(1)).toMatchObject({scale:4,flipH:true});
    expect(at(2)).toMatchObject({scale:4.5,flipH:true});
  });
});
it('preserves a legacy position clock after cuts and captures its visible layout with one Undo',()=>{
  const doc=fixture(),item=clip(doc,'video');item.clock.rate=r(2);
  item.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.75,keyframesOutside:'base',keyframeClock:{offset:r(120),rate:r(1),duration:r(900)},keyframes:[{frame:r(120),value:{scale:1},easing:'easeInOut'},{frame:r(420),value:{scale:3}}]};
  const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:60,endFrame:90}),fragment=cut.clips.find(c=>c.content.kind==='video'&&c.startFrame===60)!;
  expect(visualKeyframeTime(fragment,100)).toEqual(r(250));expect(sampleVisualTransform(fragment,100)).toEqual(sampleVisualTransform(item,130));
  const before=sampleVisualTransform(fragment,100),visual=punchVisualKeyframe(fragment,100);
  expect(visual.keyframeClock).toEqual(fragment.visual!.keyframeClock);expect(visual.keyframesOutside).toBe('base');
  expect(visual.keyframes.map(key=>key.frame)).toEqual([r(120),r(250),r(420)]);
  const session=new SequenceSession('position-keys',cut);session.execute({sessionId:session.id,expectedRevision:cut.revision,executionId:'key',command:{type:'update-clip',clipId:fragment.id,patch:{visual}}});
  expect(new ScenePlan(session.document).frame(100).visuals.find(v=>v.clip.id===fragment.id)!.transform).toEqual(before);
  session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo-key',command:{type:'undo'}});
  expect(clip(session.document,fragment.id).visual).toEqual(fragment.visual);
});
it('enriches an immutable component catalog without changing its source binding and rejects invalid entries',()=>{
  const doc=fixture(),asset={id:'text-component',kind:'component' as const,file:'.harness/components/text.mjs',name:'元の部品',fingerprint:'fixed-source',streams:[]};
  doc.assets.push(asset);
  const catalog={source:'project' as const,packId:'project.template',version:'fixed-so',componentHash:'0123456789abcdef',entries:[{id:72,name:'独自スタイル'}]};
  const next=applySequenceCommand(doc,{type:'register-assets',assets:[{...asset,name:'置き換え不可',textStyleCatalog:catalog}]});
  expect(next.assets.find(item=>item.id===asset.id)).toEqual({...asset,textStyleCatalog:catalog});
  expect(parseSequence(serializeSequence(next)).assets).toEqual(next.assets);
  for(const entries of [[],[{id:0,name:'不正'}],[{id:1,name:''}],[{id:1,name:'同じ番号'},{id:1,name:'重複'}],[{id:1,name:'A',animations:['slideOut']}],[{id:1,name:'A',animations:'x' as unknown as string[]}]])
    expect(()=>applySequenceCommand(doc,{type:'register-assets',assets:[{...asset,textStyleCatalog:{source:'project',packId:'project.template',version:'fixed-so',componentHash:'0123456789abcdef',entries}}]})).toThrow('文字スタイルの一覧が不正です');
  expect(()=>applySequenceCommand(doc,{type:'register-assets',assets:[{...asset,textStyleCatalog:{source:'project',packId:'project.template',version:'fixed-so',componentHash:'0123456789abcdef',entries:[{id:1,name:'A',animations:['none','fadeOnly']}]}}]})).not.toThrow();
  expect(()=>applySequenceCommand(doc,{type:'register-assets',assets:[{...asset,fingerprint:'changed',textStyleCatalog:catalog}]})).toThrow('同じ素材IDに異なる素材があります');
});
it('reads a legacy document without textStylePrefs and round-trips the hidden-style list once set',()=>{
  const legacy=fixture();
  expect(legacy.textStylePrefs).toBeUndefined();
  validateSequenceDocument(legacy);
  expect(parseSequence(serializeSequence(legacy)).textStylePrefs).toBeUndefined();
  const asset={id:'text-component',kind:'component' as const,file:'.harness/components/text.mjs',name:'部品',fingerprint:'fixed-source',streams:[],
    textStyleCatalog:{source:'project' as const,packId:'project.template',version:'1',componentHash:'0123456789abcdef',entries:[{id:1,name:'A'},{id:2,name:'B'}]}};
  const withAsset=applySequenceCommand(legacy,{type:'register-assets',assets:[asset]});
  const next=applySequenceCommand(withAsset,{type:'set-text-style-hidden',assetId:'text-component',hidden:[2]});
  expect(next.textStylePrefs).toEqual({hidden:{'text-component':[2]}});
  expect(parseSequence(serializeSequence(next)).textStylePrefs).toEqual({hidden:{'text-component':[2]}});
});
it('preserves both text styles and per-clip bindings across mode changes, serialization, cuts and Undo',()=>{
  const doc=fixture();
  for(const id of ['original-text','alternate-text'])doc.assets.push({id,kind:'component',file:`.harness/components/${id}.mjs`,name:id,fingerprint:id,streams:[]});
  doc.rendering={telopComponentAssetId:'original-text',telopBottomOffset:null,telopFontSize:null};
  const original=clip(doc,'telop');if(original.content.kind!=='telop')throw new Error('fixture');
  original.content.data.template=2;
  const session=new SequenceSession('styles',doc),free={...withTextMode(original.content,'free'),appearance:{...DEFAULT_TEXT_APPEARANCE,fontSize:37,strokeWidth:2}};
  session.execute({sessionId:'styles',executionId:'free',expectedRevision:0,command:{type:'update-clip',clipId:'telop',patch:{content:free}}});
  const styled={...withTextMode(free,'component'),componentAssetId:'alternate-text'};
  const next=session.execute({sessionId:'styles',executionId:'style',expectedRevision:1,command:{type:'update-clip',clipId:'telop',patch:{content:styled}}}).document;
  expect(activeTextAppearance(styled)).toBeUndefined();expect(textComponentId(next,styled)).toBe('alternate-text');
  expect(next.rendering?.telopComponentAssetId).toBe('original-text');expect(styled.appearance).toEqual(free.appearance);
  const restored=withTextMode(styled,'free');expect(activeTextAppearance(restored)).toEqual(free.appearance);expect(restored.data).toEqual(original.content.data);
  const parsed=parseSequence(serializeSequence(next));expect(clip(parsed,'telop').content).toEqual(styled);
  const split=applySequenceCommand(parsed,{type:'split',clipIds:['telop'],frame:120});
  for(const part of split.clips.filter(c=>c.content.kind==='telop'))expect(part.content).toEqual(styled);
  const undo=session.execute({sessionId:'styles',executionId:'undo',expectedRevision:2,command:{type:'undo'}}).document;
  expect(clip(undo,'telop').content).toEqual(free);expect(clip(undo,'telop').clock).toEqual(original.clock);expect(clip(undo,'telop').anchor).toEqual(original.anchor);
});
it('rejects missing text components atomically and retains the original implicit free-text behavior',()=>{
  const doc=fixture(),original=clip(doc,'telop');if(original.content.kind!=='telop')throw new Error('fixture');
  const free=withTextMode(original.content,'free');expect(activeTextAppearance({...free,textMode:undefined})).toEqual(DEFAULT_TEXT_APPEARANCE);
  for(const content of [{...free,textMode:'component' as const},{...free,componentAssetId:'source'},{...free,componentAssetId:'missing'}])
    expect(()=>applySequenceCommand(doc,{type:'update-clip',clipId:'telop',patch:{content}})).toThrow('文字の描画部品がありません');
  expect(original.content.appearance).toBeUndefined();expect(doc.revision).toBe(0);
});
it('reorders all layers together while preserving source samples and animation clocks; one Undo restores everything',()=>{
  const doc=fixture();clip(doc,'video').visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[{frame:r(0),value:{scale:1},easing:'linear'},{frame:r(300),value:{scale:2},easing:'linear'}]};
  const session=new SequenceSession('reorder',doc),ranges=[{startFrame:180,endFrame:270},{startFrame:30,endFrame:120}];
  const next=session.execute({sessionId:'reorder',expectedRevision:0,executionId:'structure',command:{type:'reorder-ranges',ranges}}).document;
  expect(next.sequenceEndFrame).toBe(180);expect(next.transcripts).toEqual(doc.transcripts);
  const before=new ScenePlan(doc),after=new ScenePlan(next);
  const pixels=(plan:ScenePlan,frame:number)=>plan.frame(frame).visuals.map(item=>({kind:item.clip.content.kind,source:item.sourceTime,effect:item.effectFrame,duration:item.effectDuration,transform:item.transform}));
  for(let frame=0;frame<180;frame++)expect(pixels(after,frame)).toEqual(pixels(before,frame<90?frame+180:frame-90+30));
  const sampleRate=3000,input=Float32Array.from({length:sampleRate*12},(_,i)=>Math.sin(i*.073)*.1),pcm=new Map([[pcmKey('source',1,r(1)),{assetId:'source',streamIndex:1,rate:r(1),sampleRate,channels:[input]}]]);
  const rendered=mixAudioBlock(after,pcm,0,18000,sampleRate)[0],original=mixAudioBlock(before,pcm,0,30000,sampleRate)[0];
  expect(rendered.slice(0,9000)).toEqual(original.slice(18000,27000));expect(rendered.slice(9000)).toEqual(original.slice(3000,12000));
  const restored=session.execute({sessionId:'reorder',expectedRevision:1,executionId:'undo-structure',command:{type:'undo'}}).document;
  expect(sequenceContentBytes(restored)).toBe(sequenceContentBytes(doc));
});
it('rejects repeated source ranges and transition cuts atomically, while an unchanged partition creates no history',()=>{
  const doc=withTransition(),session=new SequenceSession('ranges',doc);
  expect(applySequenceCommand(doc,{type:'reorder-ranges',ranges:[{startFrame:0,endFrame:100},{startFrame:100,endFrame:570}]})).toBe(doc);
  for(const ranges of [[{startFrame:0,endFrame:300},{startFrame:270,endFrame:570}],[{startFrame:0,endFrame:280},{startFrame:400,endFrame:570}]])
    expect(()=>session.execute({sessionId:'ranges',expectedRevision:0,executionId:JSON.stringify(ranges),command:{type:'reorder-ranges',ranges}})).toThrow();
  expect(session.canUndo).toBe(false);expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(doc));
  const reordered=applySequenceCommand(doc,{type:'reorder-ranges',ranges:[{startFrame:200,endFrame:400},{startFrame:0,endFrame:200},{startFrame:400,endFrame:570}]});
  expect(reordered.transitions[0]!.startFrame).toBe(70);
});
it('stores the script independently, preserves the scene, and restores it in one Undo',()=>{
  const doc=fixture(),session=new SequenceSession('script-session',doc),script=createScriptDocument('撮影した文章\n改行も残す',{documentId:'script',revision:'one'});
  const apply=(command:Parameters<SequenceSession['execute']>[0]['command'],executionId:string)=>session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId,command});
  const changed=apply({type:'set-script',script},'script');
  expect(changed.document.clips).toEqual(doc.clips);expect(changed.document.transcripts).toEqual(doc.transcripts);
  expect(parseSequence(serializeSequence(changed.document)).scriptDocument).toEqual(script);
  expect(apply({type:'set-script',script:createScriptDocument(script.text,{documentId:'script',revision:'two'})},'same').changed).toBe(false);
  expect(()=>apply({type:'set-script',script:{...script,passages:[]}},'invalid')).toThrow();
  expect(apply({type:'undo'},'undo').document.scriptDocument).toBeUndefined();
  expect(apply({type:'redo'},'redo').document.scriptDocument).toEqual(script);
  expect(apply({type:'set-script',script:null},'remove').document.scriptDocument).toBeUndefined();
  expect(apply({type:'undo'},'restore').document.scriptDocument).toEqual(script);
});
it('auditions the explicit source audio stream at original speed and time, independent of cuts and edits',()=>{
  const doc=fixture(),audio=clip(doc,'audio');
  if(audio.content.kind!=='audio')throw new Error('fixture');
  doc.assets[0]!.streams.push({index:2,kind:'audio',codec:'aac',duration:r(12),sampleRate:48000,channels:2});
  audio.content.streamIndex=2;audio.content.sourceIn=r(3);audio.content.rate=r(1,2);audio.content.settings.gainDb=-12;
  clip(doc,'telop').anchor={kind:'source',role:'speech',sourceAssetId:'source',clipOccurrenceId:'audio',sourceStart:r(7,2),sourceEnd:r(15,2)};
  const before=serializeSequence(doc),source=sourceReviewDocument(doc,'audio'),plan=new ScenePlan(source);
  expect(source.sequenceEndFrame).toBe(360);expect(source.clips).toHaveLength(2);
  expect(source.clips.find(c=>c.content.kind==='audio')!.content).toMatchObject({streamIndex:2,sourceIn:r(0),rate:r(1),settings:{gainDb:0}});
  expect(sourceTimeAt(source.clips[0]!,30,source.fps)).toEqual(r(1));
  expect(plan.audibleClips).toHaveLength(1);expect(serializeSequence(doc)).toBe(before);
  audio.content.settings.muted=true;expect(()=>sourceReviewDocument(doc,'audio')).toThrow(/音声/);
  expect(()=>sourceReviewDocument(doc,'video')).toThrow(/原音/);
});
function continued(doc: SequenceDocument, id: string): SequenceClip[] { return doc.clips.filter(c => c.id === id || c.continuationGroupId === id); }
function withTransition(): SequenceDocument {
  const doc = fixture();
  doc.clips = doc.clips.filter(c => c.id === 'video');
  delete doc.clips[0]!.linkGroupId;
  doc.clips.push({ ...structuredClone(doc.clips[0]!), id: 'video2', startFrame: 270 });
  doc.transitions = [{ id: 'fade', kind: 'crossfade', trackId: 'v1', outClipId: 'video', inClipId: 'video2', startFrame: 270, durationFrames: 30 }];
  doc.sequenceEndFrame = 570;
  return doc;
}

describe('exact sequence time', () => {
  it('distinguishes decimal fps from NTSC and retains exact frame times', () => {
    expect(rationalFromDecimal(29.97)).toEqual(r(2997, 100));
    expect(compareTime(rationalFromDecimal(29.97), r(30000, 1001))).toBe(-1);
    expect(frameSeconds(30000, r(30000, 1001))).toEqual(r(1001));
    expect(multiplyTime(frameSeconds(9000000000000, r(30000, 1001)), r(30000, 1001))).toEqual(r(9000000000000));
    expect(() => frameSeconds(Number.MAX_SAFE_INTEGER, r(30000, 1001))).toThrow(/範囲/);
  });
  it('reduces large intermediate products and rejects actual overflow', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(multiplyTime(r(max, 2), r(2, max))).toEqual(r(1));
    expect(() => addTime(r(max), r(1))).toThrow(/範囲/);
    expect(() => divideTime(r(1), r(0))).toThrow();
    expect(floorTime(r(-1, 3))).toBe(-1);
    expect(rationalFromDecimal('1.25e-2')).toEqual(r(1, 80));
  });
});

describe('document boundary', () => {
  it('roundtrips and excludes revision from canonical content', () => {
    const doc = fixture();
    const equivalent = structuredClone(doc);
    equivalent.revision = 8;
    equivalent.fps = { den: 2, num: 60 };
    expect(sequenceContentBytes(equivalent)).toBe(sequenceContentBytes(doc));
    expect(parseSequence(serializeSequence(doc))).toEqual(doc);
    expect(clip(doc, 'music').durationFrames).toBeGreaterThan(doc.sequenceEndFrame);
  });
  it('rejects dangling occurrence references and unmanaged asset paths', () => {
    const doc = fixture();
    clip(doc, 'telop').anchor = { kind: 'source', role: 'speech', sourceAssetId: 'source', clipOccurrenceId: 'video', sourceStart: r(1), sourceEnd: r(9) };
    expect(() => validateSequenceDocument(doc)).toThrow(/対応/);
    const other = fixture(); other.assets[0]!.file = '../escape.mp4';
    expect(() => validateSequenceDocument(other)).toThrow(/保存先/);
  });
  it('rejects non-finite and sparse JSON rather than silently changing data', () => {
    const doc = fixture(); doc.clips[0]!.clock.offset.num = NaN;
    expect(() => serializeSequence(doc)).toThrow(/NaN/);
    const sparse = fixture(); sparse.clips.length += 1;
    expect(() => serializeSequence(sparse)).toThrow(/配列/);
  });
  it('allows exactly the declared overlap and refuses accidental track collisions', () => {
    const doc = withTransition(); expect(() => validateSequenceDocument(doc)).not.toThrow();
    doc.transitions = []; expect(() => validateSequenceDocument(doc)).toThrow(/重な/);
  });
});

describe('atomic editing', () => {
  it('ripple removes the same interval everywhere, preserving source and original effect phase', () => {
    const doc = fixture(); const before = serializeSequence(doc);
    const next = applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 90, endFrame: 150 });
    expect(serializeSequence(doc)).toBe(before);
    expect(next.revision).toBe(1); expect(next.sequenceEndFrame).toBe(240);
    for (const id of ['video', 'audio', 'telop', 'music']) expect(continued(next, id)).toHaveLength(2);
    const video = continued(next, 'video')[1]!, audio = continued(next, 'audio')[1]!, text = continued(next, 'telop')[1]!;
    expect(video.id).not.toBe(audio.id); expect(video.linkGroupId).toBe(audio.linkGroupId);
    expect(video.linkGroupId).not.toBe('linked');
    expect(sourceTimeAt(video, 90, next.fps)).toEqual(r(5));
    expect(effectFrameAt(text, 90)).toEqual(r(120));
    expect(text.clock.duration).toEqual(r(240));
    expect(text.anchor).toMatchObject({ clipOccurrenceId: audio.id, sourceStart: r(5), sourceEnd: r(9) });
    expect(Math.max(...continued(next, 'music').map(clipEnd))).toBe(300);
  });
  it('preserves source time and anchors at double speed', () => {
    const doc = fixture();
    for (const id of ['video', 'audio']) {
      const c = clip(doc, id); if (c.content.kind === 'video' || c.content.kind === 'audio') c.content.rate = r(2);
    }
    const a = clip(doc, 'telop').anchor!; if (a.kind === 'source') { a.sourceStart = r(2); a.sourceEnd = r(18); }
    const next = applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 90, endFrame: 150 });
    expect(sourceTimeAt(continued(next, 'video')[1]!, 90, next.fps)).toEqual(r(10));
    expect(continued(next, 'telop')[1]!.anchor).toMatchObject({ sourceStart: r(10), sourceEnd: r(18) });
  });
  it('keeps the old ID on the first surviving fragment, including a head cut', () => {
    const next = applySequenceCommand(fixture(), { type: 'ripple-delete', startFrame: 0, endFrame: 150 });
    expect(clip(next, 'video').startFrame).toBe(0);
    expect(clip(next, 'telop').anchor).toMatchObject({ clipOccurrenceId: 'audio', sourceStart: r(5) });
  });
  it('retargets a transition to the continuation fragment and does not subtract overlap twice', () => {
    const next = applySequenceCommand(withTransition(), { type: 'ripple-delete', startFrame: 100, endFrame: 150 });
    expect(next.sequenceEndFrame).toBe(520);
    expect(continued(next, 'video')[1]).toMatchObject({ startFrame: 100, durationFrames: 150 });
    expect(clip(next, 'video2').startFrame).toBe(220);
    expect(next.transitions[0]).toMatchObject({ startFrame: 220, durationFrames: 30, outClipId: continued(next, 'video')[1]!.id, inClipId: 'video2' });
  });
  it.each([[280, 290], [260, 310], [270, 300]])('rejects transition intersection [%i,%i) atomically', (startFrame, endFrame) => {
    const doc = withTransition(); const before = serializeSequence(doc);
    expect(() => applySequenceCommand(doc, { type: 'ripple-delete', startFrame, endFrame })).toThrow(/転換/);
    expect(serializeSequence(doc)).toBe(before);
  });
  it('allows cuts touching, but not entering, transition boundaries', () => {
    expect(() => applySequenceCommand(withTransition(), { type: 'ripple-delete', startFrame: 200, endFrame: 270 })).not.toThrow();
    expect(() => applySequenceCommand(withTransition(), { type: 'ripple-delete', startFrame: 300, endFrame: 350 })).not.toThrow();
  });
  it('splits linked original audio and its captions without restarting animation', () => {
    const next = applySequenceCommand(fixture(), { type: 'split', clipIds: ['video'], frame: 100 });
    expect(next.sequenceEndFrame).toBe(300);
    const text = continued(next, 'telop')[1]!;
    expect(text.startFrame).toBe(100); expect(text.clock.offset).toEqual(r(70));
    expect(text.anchor).toMatchObject({ clipOccurrenceId: continued(next, 'audio')[1]!.id });
  });
  it('unlink preserves all occurrence IDs; captions follow the audio instead of the moved video', () => {
    const original = fixture();
    const unlinked = applySequenceCommand(original, { type: 'unlink', clipIds: ['video'] });
    expect(unlinked.clips.map(c => c.id)).toEqual(original.clips.map(c => c.id));
    const moved = applySequenceCommand(unlinked, { type: 'move', clipIds: ['video'], deltaFrames: 60 });
    expect(clip(moved, 'audio').startFrame).toBe(0); expect(clip(moved, 'telop').startFrame).toBe(30);
    const audioMoved = applySequenceCommand(moved, { type: 'move', clipIds: ['audio'], deltaFrames: 30 });
    expect(clip(audioMoved, 'telop').startFrame).toBe(60);
  });
  it('deleting only audio makes its surviving captions timeline anchored', () => {
    const next = applySequenceCommand(fixture(), { type: 'delete', clipIds: ['audio'], linked: false });
    expect(clip(next, 'telop').anchor).toEqual({ kind: 'timeline' });
    expect(clip(next, 'telop').startFrame).toBe(30); expect(clip(next, 'video')).toBeDefined();
  });
  it('manually moving a subtitle detaches its source anchor without extending to an unrelated old BGM tail', () => {
    const next = applySequenceCommand(fixture(), { type: 'move', clipIds: ['telop'], deltaFrames: 15 });
    expect(clip(next, 'telop').startFrame).toBe(45);
    expect(clip(next, 'telop').anchor).toEqual({ kind: 'timeline' });
    expect(next.sequenceEndFrame).toBe(300);
  });
  it('a full ripple removes subtitles without resurrecting them as detached copies', () => {
    const next = applySequenceCommand(fixture(), { type: 'ripple-delete', startFrame: 0, endFrame: 300 });
    expect(next.sequenceEndFrame).toBe(0); expect(next.clips.map(c => c.id)).toEqual(['music']);
  });
  it('does not advance the revision for no-op cuts, split boundaries or equal property edits', () => {
    const doc = fixture();
    expect(applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 10, endFrame: 10 })).toBe(doc);
    expect(applySequenceCommand(doc, { type: 'split', clipIds: ['video'], frame: 0 })).toBe(doc);
    expect(applySequenceCommand(doc, { type: 'update-clip', clipId: 'video', patch: { name: '映像' } })).toBe(doc);
  });
  it('rejects collision and out-of-media trims without partially editing linked audio', () => {
    const doc = fixture(); const before = serializeSequence(doc);
    expect(() => applySequenceCommand(doc, { type: 'trim', clipId: 'video', edge: 'end', frame: 2000 })).toThrow(/終端/);
    expect(serializeSequence(doc)).toBe(before);
    expect(() => applySequenceCommand(doc, { type: 'move', clipIds: ['video'], deltaFrames: -1 })).toThrow();
  });
});

describe('edit session history and retry safety', () => {
  it('one undo restores the entire cut, while edit revision still advances', () => {
    const original = fixture(), session = new SequenceSession('session', original);
    session.execute({ sessionId: 'session', executionId: 'cut', expectedRevision: 0,
      command: { type: 'ripple-delete', startFrame: 90, endFrame: 150 } });
    expect(session.document.clips.length).toBe(8);
    const undo = session.execute({ sessionId: 'session', executionId: 'undo', expectedRevision: 1, command: { type: 'undo' } });
    expect(sequenceContentBytes(undo.document)).toBe(sequenceContentBytes(original));
    expect(undo.document.revision).toBe(2); expect(session.canRedo).toBe(true);
    const redo = session.execute({ sessionId: 'session', executionId: 'redo', expectedRevision: 2, command: { type: 'redo' } });
    expect(redo.document.sequenceEndFrame).toBe(240); expect(redo.document.revision).toBe(3);
  });
  it('a lost-response retry returns a receipt without applying the cut twice or rewinding subsequent edits', () => {
    const session = new SequenceSession('session', fixture());
    const request = { sessionId: 'session', executionId: 'cut', expectedRevision: 0,
      command: { type: 'ripple-delete' as const, startFrame: 90, endFrame: 150 } };
    session.execute(request);
    session.execute({ sessionId: 'session', executionId: 'rename', expectedRevision: 1,
      command: { type: 'update-clip', clipId: 'video', patch: { name: '名前変更' } } });
    const replay = session.execute(request);
    expect(replay.replayed).toBe(true); expect(replay.appliedRevision).toBe(1);
    expect(replay.document.revision).toBe(2); expect(clip(replay.document, 'video').name).toBe('名前変更');
    expect(() => session.execute({ ...request, command: { ...request.command, endFrame: 160 } })).toThrow(/実行ID/);
  });
  it('rejects stale AI operations and other sessions, including after undo to identical content', () => {
    const session = new SequenceSession('session', fixture());
    session.execute({ sessionId: 'session', executionId: 'split', expectedRevision: 0, command: { type: 'split', clipIds: ['video'], frame: 100 } });
    session.execute({ sessionId: 'session', executionId: 'undo', expectedRevision: 1, command: { type: 'undo' } });
    expect(() => session.execute({ sessionId: 'session', executionId: 'old-ai', expectedRevision: 0, command: { type: 'delete', clipIds: ['video'] } })).toThrow(/更新/);
    expect(() => session.execute({ sessionId: 'other', executionId: 'ai', expectedRevision: 2, command: { type: 'delete', clipIds: ['video'] } })).toThrow(/セッション/);
  });
  it('returns isolated snapshots so consumers cannot mutate history', () => {
    const doc = fixture(), session = new SequenceSession('session', doc);
    doc.name = 'mutated'; session.document.name = 'also mutated';
    expect(session.document.name).toBe('検証');
    expect(session.execute({ sessionId: 'session', executionId: 'undo-empty', expectedRevision: 0, command: { type: 'undo' } }).changed).toBe(false);
    expect(session.document.revision).toBe(0);
  });
});

describe('atomic editing batches', () => {
  it('changes compositing order without changing clip timing or audio links', () => {
    const doc = fixture(), moved = applySequenceCommand(doc, { type:'move-track',trackId:'v1',index:1 });
    expect(new ScenePlan(doc).frame(60).visuals.map(v=>v.clip.id)).toEqual(['video','telop']);
    expect(new ScenePlan(moved).frame(60).visuals.map(v=>v.clip.id)).toEqual(['telop','video']);
    expect(moved.clips).toEqual(doc.clips);
    expect(() => applySequenceCommand(doc, {type:'move-track',trackId:'v1',index:99})).toThrow(/移動先/);
  });
  it('keeps manual typography through split/save and rejects malformed font settings', () => {
    const doc = fixture(), text = clip(doc, 'telop');
    if (text.content.kind !== 'telop') throw new Error('fixture');
    text.content.appearance = { ...DEFAULT_TEXT_APPEARANCE, fontSize: 73, letterSpacing: 2, strokeWidth: 3 };
    const split = parseSequence(serializeSequence(applySequenceCommand(doc, { type: 'split', clipIds: ['telop'], frame: 120 })));
    for (const part of split.clips.filter(c => c.content.kind === 'telop')) expect(part.content).toMatchObject({ appearance: text.content.appearance });
    text.content.appearance.lineHeight = 0;
    expect(() => validateSequenceDocument(doc)).toThrow(/書式/);
  });
  it('adds a track and clip in one revision and restores both with one undo', () => {
    const doc = fixture(), session = new SequenceSession('batch-session', doc);
    const added = { ...structuredClone(clip(doc, 'telop')), id: 'added', trackId: 'added-track' };
    delete added.anchor;
    const receipt = session.execute({ sessionId: 'batch-session', expectedRevision: 0, executionId: 'insert-batch', command: { type: 'batch', commands: [
      { type: 'add-track', track: { id: 'added-track', kind: 'visual', name: '文字', enabled: true } },
      { type: 'insert', clips: [added] },
    ] } });
    expect(receipt.document.revision).toBe(1); expect(receipt.document.clips).toHaveLength(doc.clips.length + 1);
    const undone = session.execute({ sessionId: 'batch-session', expectedRevision: 1, executionId: 'undo-batch', command: { type: 'undo' } });
    expect(sequenceContentBytes(undone.document)).toBe(sequenceContentBytes(doc)); expect(session.canUndo).toBe(false);
  });
  it('does not retain earlier operations or history when a later batch operation fails', () => {
    const doc = fixture(), session = new SequenceSession('batch-session', doc);
    expect(() => session.execute({ sessionId: 'batch-session', expectedRevision: 0, executionId: 'bad-batch', command: { type: 'batch', commands: [
      { type: 'update-clip', clipId: 'video', patch: { name: '途中の変更' } },
      { type: 'trim', clipId: 'video', edge: 'end', frame: -1 },
    ] } })).toThrow();
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(doc));
    expect(session.document.revision).toBe(0); expect(session.canUndo).toBe(false);
  });
});

describe('source speech selection', () => {
  it('requires the occurrence when the same speech is reused and maps the chosen occurrence', () => {
    const doc = fixture();
    const reused = structuredClone(clip(doc, 'audio')); reused.id = 'reused'; reused.startFrame = 300; delete reused.linkGroupId;
    doc.clips.push(reused); doc.sequenceEndFrame = 600;
    const selection = { assetId: 'source', streamIndex: 1, start: r(1), end: r(2) };
    expect(() => speechSelectionRange(doc, selection)).toThrow(/複数/);
    expect(speechSelectionRange(doc, { ...selection, occurrenceId: 'reused' })).toEqual({ startFrame: 330, endFrame: 360 });
  });
  it('keeps captions when audio is muted but refuses a word cut on that occurrence', () => {
    const doc = fixture(); const audio = clip(doc, 'audio');
    if (audio.content.kind === 'audio') audio.content.settings.muted = true;
    expect(() => validateSequenceDocument(doc)).not.toThrow();
    expect(() => speechSelectionRange(doc, { assetId: 'source', streamIndex: 1, occurrenceId: 'audio', start: r(1), end: r(2) })).toThrow(/発話/);
  });
  it('rounds source selection outward at the integer frame boundary', () => {
    expect(speechSelectionRange(fixture(), { assetId: 'source', streamIndex: 1, occurrenceId: 'audio', start: r(101, 100), end: r(201, 100) }))
      .toEqual({ startFrame: 30, endFrame: 61 });
  });
});

describe('shared scene and PCM plan', () => {
  it('freezes the export revision without rereading mutable editor state', () => {
    const doc = fixture(), plan = new ScenePlan(doc);
    doc.name = '後の編集'; doc.sequenceEndFrame = 12;
    expect(plan.document.sequenceEndFrame).toBe(300); expect(plan.document.name).toBe('検証');
    expect(() => { plan.document.name = 'mutation'; }).toThrow();
  });
  it('preserves motion/keyframes and the media frame after an interior cut', () => {
    const doc = fixture();
    clip(doc, 'video').visual = { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: .8,
      keyframes: [{ frame: r(0), value: { scale: 1 } }, { frame: r(299), value: { scale: 2 } }] };
    const original = new ScenePlan(doc).frame(180).visuals.find(v => v.clip.id === 'video')!;
    const edited = new ScenePlan(applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 90, endFrame: 150 })).frame(120).visuals.find(v => v.clip.content.kind === 'video')!;
    expect(edited.transform).toEqual(original.transform); expect(edited.sourceTime).toEqual(original.sourceTime);
    expect(edited.effectFrame).toBe(original.effectFrame);
  });
  it('derives ducking from each audible occurrence, after unlink and move', () => {
    const doc = fixture(); doc.ducking.enabled = true;
    doc.transcripts = [{ assetId: 'source', streamIndex: 1, words: [{ id: 'word', text: '発話', start: r(1), end: r(2) }] }];
    const unlinked = applySequenceCommand(doc, { type: 'unlink', clipIds: ['video'] });
    const moved = applySequenceCommand(unlinked, { type: 'move', clipIds: ['audio'], deltaFrames: 90 });
    const plan = new ScenePlan(moved);
    expect(plan.speechRegions).toEqual([{ startFrame: r(120), endFrame: r(150) }]);
    expect(plan.audioGain(clip(moved, 'music'), 130)).toBeCloseTo(10 ** (-12 / 20) * .5);
    const muted = structuredClone(moved), content = clip(muted, 'audio').content;
    if (content.kind === 'audio') content.settings.muted = true;
    expect(new ScenePlan(muted).speechRegions).toEqual([]);
  });
  it('uses identical samples for sequential blocks and offline mixing, including a ripple cut', () => {
    const doc = fixture(); doc.clips = doc.clips.filter(c => c.id !== 'music');
    const next = applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 90, endFrame: 150 });
    const plan = new ScenePlan(next), rate = 3000, input = new Float32Array(rate * 10);
    input[15001] = .75;
    const sources = new Map([[pcmKey('source', 1, r(1)), { assetId: 'source', streamIndex: 1, rate: r(1), sampleRate: rate, channels: [input] }]]);
    const offline = mixAudioBlock(plan, sources, 0, rate * 8, rate)[0];
    expect(offline[9001]).toBeCloseTo(.75, 6); expect(offline[15001]).toBe(0);
    const blocked = new Float32Array(offline.length);
    for (let start = 0; start < blocked.length; start += 257) blocked.set(mixAudioBlock(plan, sources, start, Math.min(257, blocked.length - start), rate)[0], start);
    expect(blocked).toEqual(offline);
  });
  it('keeps the original audio fade phase on continuation fragments', () => {
    const doc = fixture(); const audio = clip(doc, 'audio');
    if (audio.content.kind === 'audio') audio.content.settings.fadeOutFrames = 240;
    const original = new ScenePlan(doc), next = applySequenceCommand(doc, { type: 'ripple-delete', startFrame: 90, endFrame: 150 });
    const plan = new ScenePlan(next), part = continued(next, 'audio')[1]!;
    expect(plan.audioGain(part, 180.5)).toBeCloseTo(original.audioGain(audio, 240.5), 12);
  });
  it('apply-text-style-all は動きの解除も同じ 1 コマンドで行う（Undo 1 回で戻る）', () => {
    const base = fixture();
    base.assets.push({ id: 'component-1', kind: 'component', file: 'public/component-1.tsx', name: 'スタイル部品', fingerprint: 'component',
      streams: [], textStyleCatalog: { source: 'project', entries: [{ id: 1, name: 'スタイル 1' }, { id: 2, name: 'スタイル 2' }] } });
    const captions = base.clips.filter(clip => clip.content.kind === 'telop');
    for (const clip of captions) (clip.content as { data: { animation?: string } }).data.animation = 'popIn';
    const asset = base.assets.find(item => item.kind === 'component')!;
    const next = applySequenceCommand(base, { type: 'apply-text-style-all', assetId: asset.id, styleId: 2, clearUnsupportedAnimations: true });
    for (const clip of next.clips) if (clip.content.kind === 'telop') {
      expect(clip.content.data.animation).toBe('none');
      expect(clip.content.data.template).toBe(2);
    }
    // 省略時は動きに触らない
    const kept = applySequenceCommand(base, { type: 'apply-text-style-all', assetId: asset.id, styleId: 2 });
    for (const clip of kept.clips) if (clip.content.kind === 'telop') expect(clip.content.data.animation).toBe('popIn');
  });
  it('apply-text-style-all は移行先が宣言した動きを残し、非対応の動きだけを解除する（I-3）', () => {
    const base = fixture();
    // 移行先は fadeOnly に対応し popIn に非対応。確認画面（telopClipsLosingAnimation）が数えるのも popIn の分だけ。
    base.assets.push({ id: 'component-1', kind: 'component', file: 'public/component-1.tsx', name: 'スタイル部品', fingerprint: 'component',
      streams: [], textStyleCatalog: { source: 'project', animations: ['fadeOnly', 'none'], entries: [{ id: 1, name: 'スタイル 1' }, { id: 2, name: 'スタイル 2' }] } });
    // fixture の字幕は 1 本なので、動きの違う 2 本目を足して「混在」を作る（全件同値の fixture は変異を通す）。
    const first = base.clips.find(clip => clip.content.kind === 'telop')!;
    const second = structuredClone(first);
    second.id = 'telop-2'; second.startFrame = 280; second.durationFrames = 20;
    second.clock = { offset: r(0), rate: r(1), duration: r(20) };
    delete second.anchor;
    base.clips.push(second);
    const captions = base.clips.filter(clip => clip.content.kind === 'telop');
    expect(captions.length).toBe(2);
    for (const [index, clip] of captions.entries())
      (clip.content as { data: { animation?: string } }).data.animation = index === 0 ? 'fadeOnly' : 'popIn';
    const asset = base.assets.find(item => item.id === 'component-1')!;
    // UI（onApplyAll）と同じ数え方＝移る先のスタイル番号を固定して数える。
    const losing = telopClipsLosingAnimation(base, asset, 2);
    expect(losing).toEqual(captions.slice(1).map(clip => clip.id));
    const next = applySequenceCommand(base, { type: 'apply-text-style-all', assetId: asset.id, styleId: 2, clearUnsupportedAnimations: true });
    const after = next.clips.filter(clip => clip.content.kind === 'telop');
    expect(after.map(clip => (clip.content as { data: { animation?: string } }).data.animation))
      .toEqual(['fadeOnly', ...captions.slice(1).map(() => 'none')]);
    // 解除された件数は、UI が同意を取った件数とちょうど同じ。
    expect(after.filter(clip => (clip.content as { data: { animation?: string } }).data.animation === 'none')).toHaveLength(losing.length);
  });
});
