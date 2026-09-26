import {expect,it} from 'vitest';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import type {ClipContent,SequenceClip} from './model';
import {rational as r} from './time';
import {punchVisualKeyframe,sampleVisualTransform} from './visualTransform';
import {visualPositionPolicy} from './visualPositionPolicy';

const contents:ClipContent[]=[
  {kind:'telop',textMode:'free',componentAssetId:'inactive',data:{text:'標準',position:{x:0,y:-.5}}},
  {kind:'title',data:{text:'見出し'},style:{top:10,left:20,fontSize:32}},
  {kind:'shape',data:{kind:'rect',x1:.1,y1:.1,x2:.8,y2:.8,color:'#fff',thickness:'medium'}},
];
const fixture=(content:ClipContent):SequenceClip=>({id:'a',name:'a',trackId:'v',startFrame:10,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content,
  visual:{layout:{...structuredClone(DEFAULT_MAIN_LAYOUT),position:{x:3,y:-4}},opacity:1,keyframes:[]}});
it.each(contents)('preserves native $kind outer position through base, motion and current key recording',content=>{
  const clip=fixture(content);
  expect(sampleVisualTransform(clip,10)).toMatchObject({x:3,y:-4});
  clip.visual!.motion={preset:'custom',from:{x:4,y:-6},to:{x:8,y:-10}};
  expect(sampleVisualTransform(clip,60)).toMatchObject({x:6,y:-8});
  clip.visual!.motion={preset:'keyframes',keys:[{t:0,x:4,y:-6},{t:1,x:8,y:-10}]};
  expect(sampleVisualTransform(clip,60)).toMatchObject({x:6,y:-8});
  expect(punchVisualKeyframe(clip,60).keyframes[0]!.value.position).toEqual({x:6,y:-8});
});
it('keeps legacy media and component text bounded',()=>{
  for(const content of [{kind:'telop',textMode:'component',data:{text:'部品'}} as ClipContent,
    {kind:'image',assetId:'a'} as ClipContent,{kind:'video',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)} as ClipContent])
    expect(sampleVisualTransform(fixture(content),10)).toMatchObject({x:1.5,y:-1.5});
});
it('interpolates opposite finite extremes without overflow and preserves exact endpoints',()=>{
  const clip=fixture(contents[0]!);
  clip.visual!.keyframes=[{frame:r(0),value:{position:{x:-Number.MAX_VALUE,y:Number.MAX_VALUE}}},{frame:r(100),value:{position:{x:Number.MAX_VALUE,y:-Number.MAX_VALUE}}}];
  expect(sampleVisualTransform(clip,10)).toMatchObject({x:-Number.MAX_VALUE,y:Number.MAX_VALUE});
  expect(sampleVisualTransform(clip,60)).toMatchObject({x:0,y:0});
  expect(sampleVisualTransform(clip,110)).toMatchObject({x:Number.MAX_VALUE,y:-Number.MAX_VALUE});
});
it('classifies appearance defaults and preserves inner text coordinates without rewriting them',()=>{
  const free=fixture(contents[0]!);expect(visualPositionPolicy(free)).toBe('finite');
  const implicit=fixture({kind:'telop',data:{text:'legacy'}});expect(visualPositionPolicy(implicit)).toBe('bounded');
  const before=structuredClone(free.content);sampleVisualTransform(free,10);expect(free.content).toEqual(before);
});
it.each(['linear','easeInOut'] as const)('retains base/hold, exact rational boundaries and duplicate order with %s position keys',easing=>{
  const clip=fixture(contents[0]!);
  clip.visual!.keyframeClock={offset:r(1,10),rate:r(1,5),duration:r(100)};
  clip.visual!.keyframes=[{frame:r(3,10),value:{position:{x:4,y:-4}},easing:'linear'},
    {frame:r(3,10),value:{position:{x:6,y:-6}},easing},{frame:r(7,10),value:{position:{x:10,y:-10}}}];
  clip.visual!.keyframesOutside='base';
  expect(sampleVisualTransform(clip,10)).toMatchObject({x:3,y:-4});
  expect(sampleVisualTransform(clip,11)).toMatchObject({x:6,y:-6});
  expect(sampleVisualTransform(clip,12)).toMatchObject({x:8,y:-8});
  const punched=punchVisualKeyframe(clip,11);expect(punched.keyframes).toEqual(clip.visual!.keyframes.map((key,index)=>index===1?{...key,value:{...key.value,scale:1,rotation:0,flipH:false,flipV:false,opacity:1}}:key));
  clip.visual!.keyframesOutside='hold';expect(sampleVisualTransform(clip,14)).toMatchObject({x:10,y:-10});
});
