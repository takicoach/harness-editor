import {expect,it} from 'vitest';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import type {SequenceClip} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {sampleVisualTransform} from '../../core/sequence/visualTransform';
import {previewKeysActive,previewPlacementInRange,previewPlacementVisual} from './previewGesture';

const clip=():SequenceClip=>({id:'video',name:'映像',trackId:'v',startFrame:10,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.8,keyframes:[]}});
it('updates only basic placement without changing rotation, opacity, content or source clock',()=>{
  const source=clip(),before=structuredClone(source);source.visual!.layout.rotation=21;
  const result=previewPlacementVisual(source,12,{...sampleVisualTransform(source,12),x:.2,y:-.3,scale:1.4});
  expect(result.layout.position).toEqual({x:.2,y:-.3});expect(result.layout.scale).toBe(1.4);expect(result.layout.rotation).toBe(21);expect(result.opacity).toBe(.8);
  expect(source.content).toEqual(before.content);expect(source.clock).toEqual(before.clock);expect(source.visual!.layout.position).toEqual({x:0,y:0});
});
it('records on the dedicated rational clock and preserves prior duplicate keys/easing',()=>{
  const source=clip();source.visual!.keyframeClock={offset:r(1,10),rate:r(1,5),duration:r(100)};
  source.visual!.keyframes=[{frame:r(3,10),value:{scale:1},easing:'linear'},{frame:r(3,10),value:{scale:2},easing:'easeInOut'},{frame:r(20),value:{scale:3}}];
  const before=structuredClone(source),value={...sampleVisualTransform(source,11),x:.4,y:.1,scale:1.7};
  const result=previewPlacementVisual(source,11,value);
  expect(result.keyframes).toHaveLength(3);expect(result.keyframes[0]).toEqual(before.visual!.keyframes[0]);
  expect(result.keyframes[1]).toMatchObject({frame:r(3,10),easing:'easeInOut',value:{position:{x:.4,y:.1},scale:1.7}});
  expect(result.keyframeClock).toEqual(before.visual!.keyframeClock);expect(source).toEqual(before);
});
it('edits base only outside base-mode keys, while hold-mode creates the current key',()=>{
  const source=clip();source.visual!.keyframes=[{frame:r(5),value:{scale:2}},{frame:r(10),value:{scale:3}}];source.visual!.keyframesOutside='base';
  expect(previewKeysActive(source,10)).toBe(false);expect(previewKeysActive(source,15)).toBe(true);
  const value={...sampleVisualTransform(source,10),x:.2,y:.3,scale:1.4},base=previewPlacementVisual(source,10,value);
  expect(base.keyframes).toEqual(source.visual!.keyframes);expect(base.layout.position).toEqual({x:.2,y:.3});
  source.visual!.keyframesOutside='hold';const held=previewPlacementVisual(source,10,value);
  expect(held.keyframes).toHaveLength(3);expect(held.keyframes[0]).toMatchObject({frame:r(0),value:{position:{x:.2,y:.3},scale:1.4}});
});
it('rejects unrepresentable recorded time and out-of-range candidates without modifying the clip',()=>{
  const source=clip();source.visual!.keyframeClock={offset:r(1,Number.MAX_SAFE_INTEGER),rate:r(1,2),duration:r(100)};source.visual!.keyframes=[{frame:r(0),value:{scale:1}}];
  const before=structuredClone(source),value=sampleVisualTransform(source,11);
  expect(()=>previewPlacementVisual(source,11,value)).toThrow();expect(source).toEqual(before);
  expect(()=>previewPlacementVisual(clip(),12,{...value,x:2})).toThrow('操作範囲');
});
it('commits offscreen graphic placement to base/current key while rejecting nonfinite candidates',()=>{
  const source=clip();source.content={kind:'telop',textMode:'free',data:{text:'文字'}};
  const value={...sampleVisualTransform(source,12),x:4,y:-6,scale:.5};
  expect(previewPlacementInRange(value,source)).toBe(true);expect(previewPlacementInRange(value,clip())).toBe(false);
  expect(previewPlacementVisual(source,12,value).layout.position).toEqual({x:4,y:-6});
  source.visual!.keyframes=[{frame:r(0),value:{position:{x:3,y:-5}}}];
  const result=previewPlacementVisual(source,12,value);expect(result.keyframes[1]!.value.position).toEqual({x:4,y:-6});
  expect(result.layout.position).toEqual({x:0,y:0});expect(source.visual!.keyframes).toHaveLength(1);
  expect(previewPlacementInRange({...value,x:Infinity},source)).toBe(false);
  expect(()=>previewPlacementVisual(source,12,{...value,x:NaN})).toThrow('操作範囲');
  expect(previewPlacementInRange({...value,scale:9},source)).toBe(false);
});
