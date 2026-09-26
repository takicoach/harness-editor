import {describe,expect,it} from 'vitest';
import {buildLegacySpeedProjection,type LegacySpeedProjectionInput} from './legacySpeedProjection';
import {SequenceError} from './errors';

const input=(lengths:number[],extra:Partial<LegacySpeedProjectionInput>={}):LegacySpeedProjectionInput=>{
 let cursor=0;
 const clips=lengths.map((length,i)=>{const start=cursor;cursor+=length;return {ownerId:`v${i}`,segmentId:i,playbackStart:start,playbackEnd:cursor};});
 return {family:'legacy-js-v1',evaluator:'legacy-preview-migration-v1',mainSpeed:1,segmentSpeeds:{},clips,overlaps:[],playbackDurationFrames:cursor,tailExtensionFrames:0,...extra};
};
const windows=(value:ReturnType<typeof buildLegacySpeedProjection>)=>value.main.map(c=>[c.startFrame,c.endFrame]);

describe('legacy preview/migration binary64 projection',()=>{
 it('retains the legacy decimal round side rather than exact 34/25 arithmetic',()=>{
  const p=buildLegacySpeedProjection(input([17],{mainSpeed:1.36}));
  expect(17/1.36).toBe(12.499999999999998);expect(windows(p)).toEqual([[0,12]]);expect(p.sequenceEndFrame).toBe(12);
  expect(p.followFrame(17)).toBe(12);
 });
 it('does not reassociate division into multiplication by a reciprocal',()=>{
  expect(7/.56).toBe(12.499999999999998);expect(7*(1/.56)).toBe(12.5);
  const p=buildLegacySpeedProjection(input([7],{mainSpeed:.56}));
  expect(windows(p)).toEqual([[0,12]]);expect(p.sequenceEndFrame).toBe(12);expect(p.followFrame(7)).toBe(12);
 });
 it('keeps collapse-before-speed follow distinct from main overlap placement and total',()=>{
  const source=input([4,4],{mainSpeed:2,overlaps:[{afterOwnerId:'v0',durationFrames:1}]});
  const p=buildLegacySpeedProjection(source);
  expect(windows(p)).toEqual([[0,2],[1,3]]);expect(p.mainEndFrame).toBe(3);expect(p.sequenceEndFrame).toBe(4);
  expect(p.followFrame(4)).toBe(2);expect(p.followRange(4,8)).toEqual({startFrame:2,endFrame:4});
  const restored=buildLegacySpeedProjection({...source,mainSpeed:1});
  expect(windows(restored)).toEqual([[0,4],[3,7]]);expect(restored.sequenceEndFrame).toBe(7);
  expect(buildLegacySpeedProjection({...source,tailExtensionFrames:2}).sequenceEndFrame).toBe(6);
 });
 it('uses all raw dictionary entries, including unused and same-value overrides',()=>{
  const ordinary=input([3,3,3],{mainSpeed:2});
  const equal=buildLegacySpeedProjection({...ordinary,segmentSpeeds:{0:2,999:2}});
  expect(equal.mode).toBe('uniform');expect(windows(equal)).toEqual([[0,2],[2,3],[3,5]]);
  const unused=buildLegacySpeedProjection({...ordinary,segmentSpeeds:{999:1}});
  expect(unused.mode).toBe('piecewise');expect(windows(unused)).toEqual([[0,2],[2,4],[4,6]]);
  expect(unused.sequenceEndFrame).toBe(6);expect(unused.followFrame(6)).toBe(4);
  expect(equal.inputKey).not.toBe(buildLegacySpeedProjection(ordinary).inputKey);
 });
 it('retains legacy clamp in override branch/rate resolution without changing the raw fingerprint',()=>{
  const base=input([10,10],{mainSpeed:16,segmentSpeeds:{999:20}});
  expect(buildLegacySpeedProjection(base).mode).toBe('uniform');
  expect(buildLegacySpeedProjection(base).inputKey).not.toBe(buildLegacySpeedProjection({...base,segmentSpeeds:{999:16}}).inputKey);
  const p=buildLegacySpeedProjection(input([10,10],{segmentSpeeds:{0:0}}));
  expect(p.main[0]!.rate).toBe(.1);expect(windows(p)).toEqual([[0,100],[100,110]]);
 });
 it('clamps piecewise positions at gaps/ends but uses the last rate outside half-open owners',()=>{
  const p=buildLegacySpeedProjection(input([4,4],{mainSpeed:2,segmentSpeeds:{1:4},clips:[
   {ownerId:'v0',segmentId:0,playbackStart:2,playbackEnd:6},
   {ownerId:'v1',segmentId:1,playbackStart:9,playbackEnd:13},
  ],playbackDurationFrames:16}));
  expect(windows(p)).toEqual([[0,2],[2,3]]);expect(p.sequenceEndFrame).toBe(3);
  expect([-1,0,2,6,7,9,13,99].map(f=>p.followFrame(f))).toEqual([0,0,0,2,2,2,3,3]);
  expect([-1,0,2,5,6,8,9,12,13,99].map(f=>p.rateAtCollapsedFrame(f))).toEqual([4,4,2,2,4,4,4,4,4,4]);
  expect(p.insertRateAt(6,1.5)).toBe(6);
 });
 it('retains absolute gaps and explicit pre-speed total in the uniform path',()=>{
  const p=buildLegacySpeedProjection(input([4,4],{mainSpeed:2,clips:[
   {ownerId:'a',segmentId:8,playbackStart:2,playbackEnd:6},
   {ownerId:'b',segmentId:9,playbackStart:9,playbackEnd:13},
  ],playbackDurationFrames:16}));
  expect(windows(p)).toEqual([[1,3],[5,7]]);expect(p.mainEndFrame).toBe(7);expect(p.sequenceEndFrame).toBe(8);
  expect(p.followFrame(99)).toBe(50);expect(p.rateAtCollapsedFrame(-1)).toBe(2);
 });
 it('caps original follow overlap and independently recaps the scaled main request',()=>{
  const p=buildLegacySpeedProjection(input([3,5],{mainSpeed:2,overlaps:[{afterOwnerId:'v0',durationFrames:5}]}));
  expect(p.playbackOverlaps).toEqual([{boundary:3,overlap:1}]);
  expect(windows(p)).toEqual([[0,2],[1,3]]);expect(p.followFrame(3)).toBe(1);expect(p.sequenceEndFrame).toBe(4);
 });
 it('retains TransitionSeries selection even when speed makes its overlap zero',()=>{
  const p=buildLegacySpeedProjection(input([4,4],{mainSpeed:3,overlaps:[{afterOwnerId:'v0',durationFrames:1}]}));
  expect(p.mainOverlapPath).toBe(true);expect(windows(p)).toEqual([[0,1],[1,3]]);
  expect(p.main[1]!.overlapBeforeFrames).toBe(0);expect(p.sequenceEndFrame).toBe(2);
 });
 it('does not activate TransitionSeries when the original half cap was zero',()=>{
  const p=buildLegacySpeedProjection(input([1,1],{mainSpeed:.5,overlaps:[{afterOwnerId:'v0',durationFrames:8}]}));
  expect(p.mainOverlapPath).toBe(false);expect(windows(p)).toEqual([[0,2],[2,4]]);expect(p.sequenceEndFrame).toBe(4);
 });
 it('preserves fractional requested duration through the identity speed path until the overlap cap rounds',()=>{
  const half=buildLegacySpeedProjection(input([4,4],{overlaps:[{afterOwnerId:'v0',durationFrames:.5}]}));
  expect(windows(half)).toEqual([[0,4],[3,7]]);expect(half.sequenceEndFrame).toBe(7);
  const under=buildLegacySpeedProjection(input([4,4],{overlaps:[{afterOwnerId:'v0',durationFrames:.4}]}));
  expect(windows(under)).toEqual([[0,4],[4,8]]);expect(under.sequenceEndFrame).toBe(8);
 });
 it('reports old one-frame sequence rescue without repairing legacy total or adjacent placement',()=>{
  const p=buildLegacySpeedProjection(input([1,1,1],{mainSpeed:16}));
  expect(windows(p)).toEqual([[0,1],[0,1],[0,1]]);expect(p.sequenceEndFrame).toBe(1);
  const piece=buildLegacySpeedProjection(input([1,1,1],{mainSpeed:16,segmentSpeeds:{999:1}}));
  expect(windows(piece)).toEqual([[0,1],[0,1],[0,1]]);expect(piece.sequenceEndFrame).toBe(1);
 });
 it('preserves source-only input bits and snapshots caller arrays/dictionaries',()=>{
  const source=input([4,4],{mainSpeed:2,segmentSpeeds:{999:2},overlaps:[{afterOwnerId:'v0',durationFrames:1}]});
  const original=JSON.stringify(source),p=buildLegacySpeedProjection(source);
  expect(JSON.stringify(source)).toBe(original);const key=p.inputKey;
  (source.segmentSpeeds as Record<number,number>)[999]=1;(source.clips[0] as {playbackEnd:number}).playbackEnd=99;
  expect(p.inputKey).toBe(key);expect(windows(p)).toEqual([[0,2],[1,3]]);expect(p.followFrame(8)).toBe(4);
  expect(Object.isFrozen(p.main)).toBe(true);expect(Object.isFrozen(p.main[0])).toBe(true);
  expect(p.inputKey).toContain('4000000000000000'); // 2 in big-endian IEEE754
  expect(buildLegacySpeedProjection(input([4],{overlaps:[]})).inputKey).not.toBe(buildLegacySpeedProjection(input([4],{tailExtensionFrames:-0})).inputKey);
 });
 it('rejects unresolved approximate piecewise overlap, including unused branch overrides',()=>{
  for(const segmentSpeeds of [{1:3},{999:1}] as Record<number,number>[])expect(()=>buildLegacySpeedProjection(input([20,20],{mainSpeed:2,segmentSpeeds,overlaps:[{afterOwnerId:'v0',durationFrames:4}]}))).toThrow(SequenceError);
 });
 it.each([
  ()=>({...input([4]),family:'native-exact-v1'}),()=>({...input([4]),evaluator:'legacy-server-v1'}),
  ()=>input([]),()=>input([4],{mainSpeed:NaN}),()=>input([4],{mainSpeed:0}),()=>input([4],{mainSpeed:17}),
  ()=>input([4],{segmentSpeeds:{999:Infinity}}),()=>input([4],{tailExtensionFrames:-1}),
  ()=>input([4],{overlaps:[{afterOwnerId:'missing',durationFrames:1}]}),
  ()=>input([4],{overlaps:[{afterOwnerId:'v0',durationFrames:1}]}),
  ()=>input([4,4],{overlaps:[{afterOwnerId:'v0',durationFrames:1},{afterOwnerId:'v0',durationFrames:2}]}),
  ()=>input([4],{playbackDurationFrames:3}),()=>input([0]),
  ()=>input([4],{clips:new Array(1)}),()=>input([4,4],{overlaps:new Array(1)}),
 ])('rejects invalid input without publishing a partial candidate %#',factory=>{
  const value=factory(),before=JSON.stringify(value);expect(()=>buildLegacySpeedProjection(value as LegacySpeedProjectionInput)).toThrow(SequenceError);expect(JSON.stringify(value)).toBe(before);
 });
 it('rejects final overflow and invalid frame/rate queries',()=>{
  expect(()=>buildLegacySpeedProjection(input([Number.MAX_SAFE_INTEGER],{mainSpeed:.1}))).toThrow(SequenceError);
  expect(()=>buildLegacySpeedProjection(input([4],{tailExtensionFrames:Number.MAX_SAFE_INTEGER}))).toThrow(SequenceError);
  const p=buildLegacySpeedProjection(input([4]));
  expect(()=>p.followFrame(.5)).toThrow(SequenceError);expect(()=>p.insertRateAt(0,Infinity)).toThrow(SequenceError);
 });
 it('restores all timing from the same original input across uniform/piecewise branch changes',()=>{
  const base=input([3,3,3],{mainSpeed:2,segmentSpeeds:{2:2},tailExtensionFrames:2});
  const first=buildLegacySpeedProjection(base);
  expect(buildLegacySpeedProjection({...base,mainSpeed:3}).mode).toBe('piecewise');
  const again=buildLegacySpeedProjection(base);
  expect(again.main).toEqual(first.main);expect(again.sequenceEndFrame).toBe(first.sequenceEndFrame);expect(again.inputKey).toBe(first.inputKey);
 });
});
