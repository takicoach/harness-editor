import {describe,expect,it} from 'vitest';
import {buildNativeSpeedProjection,projectInsertOwnSpeed,registerInsertOwnSpeed,type NativeSpeedBasis,type NativeSpeedBasisClip} from './speedProjection';
import {rational as q} from './time';
import {SequenceError} from './errors';

const clip=(ownerId:string,span:number,extra:Partial<NativeSpeedBasisClip>={}):NativeSpeedBasisClip=>({ownerId,span:q(span),...extra});
const basis=(clips:NativeSpeedBasisClip[],extra:Partial<NativeSpeedBasis>={}):NativeSpeedBasis=>({family:'native-exact-v1',globalRate:q(2),tailOffsetFrames:0,clips,...extra});
const windows=(value:ReturnType<typeof buildNativeSpeedProjection>)=>value.entries.map(e=>[e.startFrame,e.endFrame]);

describe('native document speed projection',()=>{
  it('preserves exact half rounding instead of legacy binary64 division',()=>{
    expect(Math.round(17/1.36)).toBe(12);
    expect(windows(buildNativeSpeedProjection(basis([clip('a',17)],{globalRate:q(34,25)})))).toEqual([[0,13]]);
    expect(()=>buildNativeSpeedProjection({...basis([clip('a',17)]),family:'legacy-js-v1'} as unknown as NativeSpeedBasis)).toThrow(SequenceError);
  });
  it('keeps same-value overrides and uses one absolute mode for all runs',()=>{
    const input=basis([clip('a',3),clip('b',3,{override:q(2)}),clip('c',3)]);
    const before=JSON.stringify(input),projection=buildNativeSpeedProjection(input);
    expect(projection.mode).toBe('absolute');expect(windows(projection)).toEqual([[0,2],[2,3],[3,5]]);
    expect(input.clips[1]!.override).toEqual(q(2));expect(JSON.stringify(input)).toBe(before);
  });
  it('a differing override in a later run changes the whole document branch',()=>{
    const projection=buildNativeSpeedProjection(basis([clip('a',3),clip('b',3),clip('c',3,{override:q(1),runHead:{phase:q(6),gapFrames:0}})]));
    expect(projection.mode).toBe('cumulative');expect(windows(projection)).toEqual([[0,2],[2,4],[4,7]]);
    expect(projection.rate('c')).toEqual(q(1));
  });
  it('keeps the original phase after trim opens a gap',()=>{
    const projection=buildNativeSpeedProjection(basis([clip('trimmed',1),clip('b',3,{runHead:{phase:q(3),gapFrames:1}}),clip('c',3)]));
    expect(windows(projection)).toEqual([[0,1],[2,3],[3,5]]);
    expect(projection.point({ownerId:'b',kind:'gap-before',offset:q(1,2)})).toBe(2);
    expect(projection.inverse('b',1,'gap-before')).toEqual(q(0));
    expect(projection.inverse('b',2,'gap-before')).toEqual(q(1));
  });
  it('does not merge a zero-gap logical run into the preceding phase',()=>{
    const separated=basis([clip('a',2),clip('b',3,{runHead:{phase:q(3),gapFrames:0}})]);
    expect(windows(buildNativeSpeedProjection(separated))).toEqual([[0,1],[1,2]]);
    expect(windows(buildNativeSpeedProjection(basis([clip('a',2),clip('b',3)])))).toEqual([[0,1],[1,3]]);
    expect(()=>buildNativeSpeedProjection(separated).inverse('b',1,'gap-before')).toThrow(SequenceError);
  });
  it('inverts by explicit owner at ambiguous shared boundaries and exact endpoints',()=>{
    const projection=buildNativeSpeedProjection(basis([clip('a',3),clip('b',3),clip('c',3)]));
    expect(projection.inverse('b',3)).toEqual(q(3));
    expect(projection.inverse('c',3)).toEqual(q(0));
    expect(projection.inverse('c',4)).toEqual(q(2));
    expect(projection.point({ownerId:'c',kind:'clip',offset:q(2)})).toBe(4);
  });
  it('scales requested uniform overlaps but preserves the explicit native tail',()=>{
    const projection=buildNativeSpeedProjection(basis([clip('a',4),clip('b',4,{overlapBefore:q(1)})],{tailOffsetFrames:1}));
    expect(windows(projection)).toEqual([[0,2],[1,3]]);expect(projection.sequenceEndFrame).toBe(4);
    expect(projection.inverse('b',4,'after-main')).toEqual(q(1));
    expect(projection.point({ownerId:'b',kind:'after-main',offset:q(1)})).toBe(4);
    const slowed=buildNativeSpeedProjection(basis([clip('a',4),clip('b',4,{overlapBefore:q(1)})],{tailOffsetFrames:1,globalRate:q(1)}));
    expect(slowed.mainEndFrame).toBe(7);expect(slowed.sequenceEndFrame).toBe(8); // native explicit tail, not legacy rounding residue
    expect(()=>projection.inverse('a',3,'after-main')).toThrow(SequenceError);
  });
  it('rejects unsupported overlap combinations instead of silently dropping them',()=>{
    expect(()=>buildNativeSpeedProjection(basis([clip('a',8),clip('b',8,{override:q(3),overlapBefore:q(2)})]))).toThrow(SequenceError);
    expect(()=>buildNativeSpeedProjection(basis([clip('a',8),clip('b',8,{runHead:{phase:q(8),gapFrames:0},overlapBefore:q(2)})]))).toThrow(SequenceError);
    expect(()=>buildNativeSpeedProjection(basis([clip('a',4),clip('b',4,{overlapBefore:q(1,10)})]))).toThrow(SequenceError);
  });
  it('preserves a completed end before the main clip end without trimming its basis',()=>{
    const input=basis([clip('a',100)],{globalRate:q(1),tailOffsetFrames:-10});
    const before=JSON.stringify(input),original=buildNativeSpeedProjection(input);
    expect(windows(original)).toEqual([[0,100]]);expect(original.sequenceEndFrame).toBe(90);
    expect(original.point({ownerId:'a',kind:'clip',offset:q(100)})).toBe(100);
    const faster=buildNativeSpeedProjection({...input,globalRate:q(2)});
    expect(windows(faster)).toEqual([[0,50]]);expect(faster.sequenceEndFrame).toBe(40);
    const restored=buildNativeSpeedProjection({...input,globalRate:q(1)});
    expect(restored.entries).toEqual(original.entries);expect(restored.sequenceEndFrame).toBe(90);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('allows a zero completed end but never creates an after-main region for a nonpositive offset',()=>{
    const empty=buildNativeSpeedProjection(basis([clip('a',100)],{globalRate:q(1),tailOffsetFrames:-100}));
    expect(empty.mainEndFrame).toBe(100);expect(empty.sequenceEndFrame).toBe(0);
    for(const offset of [-100,-10,0]){
      const p=buildNativeSpeedProjection(basis([clip('a',100)],{globalRate:q(1),tailOffsetFrames:offset}));
      expect(()=>p.point({ownerId:'a',kind:'after-main',offset:q(0)})).toThrow('末尾の領域がありません');
      expect(()=>p.inverse('a',100,'after-main')).toThrow('末尾の領域がありません');
    }
  });
  it('rejects a negative completed end and malformed signed offsets before publishing a projection',()=>{
    const input=basis([clip('a',100)],{globalRate:q(16),tailOffsetFrames:-10}),before=JSON.stringify(input);
    expect(()=>buildNativeSpeedProjection(input)).toThrow(SequenceError);expect(JSON.stringify(input)).toBe(before);
    for(const tailOffsetFrames of [-.5,NaN,Infinity,-Infinity,-Number.MAX_SAFE_INTEGER-1])
      expect(()=>buildNativeSpeedProjection(basis([clip('a',100)],{tailOffsetFrames}))).toThrow(SequenceError);
  });
  it('round trips rates from the saved basis including logical runs and override values',()=>{
    const input=basis([clip('a',40),clip('b',30,{override:q(3),runHead:{phase:q(40),gapFrames:4}}),clip('c',60)],{tailOffsetFrames:7});
    const original=buildNativeSpeedProjection(input);
    const changed=buildNativeSpeedProjection({...input,globalRate:q(5)});
    expect(windows(changed)).not.toEqual(windows(original));
    const restored=buildNativeSpeedProjection({...input,globalRate:q(2)});
    expect(restored.entries).toEqual(original.entries);expect(restored.sequenceEndFrame).toBe(original.sequenceEndFrame);
    expect(restored.rate('b')).toEqual(q(3));
  });
  it('snapshots caller-owned rationals and arrays',()=>{
    const span=q(20),override=q(3),clips=[{ownerId:'a',span,override}],input=basis(clips);
    const projection=buildNativeSpeedProjection(input);span.num=999;override.num=12;clips.length=0;
    expect(windows(projection)).toEqual([[0,7]]);expect(projection.rate('a')).toEqual(q(3));
    expect(projection.point({ownerId:'a',kind:'clip',offset:q(20)})).toBe(7);
    expect(Object.isFrozen(projection.entries)).toBe(true);expect(Object.isFrozen(projection.rate('a'))).toBe(true);
  });
  it.each([
    basis([]),basis([clip('a',4),clip('a',5)]),basis([clip('a',0)]),basis([clip('a',1)],{globalRate:q(16)}),
    basis([clip('a',4)],{globalRate:q(1,11)}),basis([clip('a',4)],{globalRate:q(17)}),
    basis([clip('a',4)],{originFrame:-1}),basis([clip('a',4)],{tailOffsetFrames:-3}),
    basis([clip('a',4,{runHead:{phase:{num:1,den:0},gapFrames:0}})]),
    basis([clip('a',4,{runHead:{phase:q(0),gapFrames:.5}})]),
    basis([clip('a',4,{runHead:null as never})]),basis([clip('a',4)],{originFrame:null as never}),
  ])('rejects invalid or zero-duration input atomically %#',input=>{
    const before=JSON.stringify(input);expect(()=>buildNativeSpeedProjection(input)).toThrow(SequenceError);expect(JSON.stringify(input)).toBe(before);
  });
  it('rejects unsafe completed end and unowned regions',()=>{
    expect(()=>buildNativeSpeedProjection(basis([clip('a',4)],{tailOffsetFrames:Number.MAX_SAFE_INTEGER}))).toThrow(SequenceError);
    const projection=buildNativeSpeedProjection(basis([clip('a',4)]));
    expect(()=>projection.rate('missing')).toThrow(SequenceError);
    expect(()=>projection.point({ownerId:'a',kind:'after-main',offset:q(0)})).toThrow(SequenceError);
  });
});

describe('stable insert own speed',()=>{
  it('restores length five after own 1 -> 3 -> 1, without cumulative rounding drift',()=>{
    const saved=registerInsertOwnSpeed(10,15,q(1));
    expect(projectInsertOwnSpeed(saved,q(3))).toEqual({startFrame:10,endFrame:12,rate:q(3)});
    expect(projectInsertOwnSpeed(saved,q(1))).toEqual({startFrame:10,endFrame:15,rate:q(1)});
    expect(saved.exposure).toEqual(q(5));expect(saved.startFrame).toBe(10);
  });
  it('retains the adopted own exposure and uses the documented one-frame minimum',()=>{
    const saved=registerInsertOwnSpeed(7,12,q(2));
    expect(projectInsertOwnSpeed(saved,q(2)).endFrame).toBe(12);
    expect(projectInsertOwnSpeed(saved,q(16)).endFrame).toBe(8);
    expect(projectInsertOwnSpeed(saved,q(1,10)).endFrame).toBe(107);
  });
  it('keeps precise decimal division in BigInt until the final integer result',()=>{
    const precise=q(1000000000000001,1000000000000000);
    expect(projectInsertOwnSpeed(registerInsertOwnSpeed(0,10,q(1)),precise).endFrame).toBe(10);
    const half=registerInsertOwnSpeed(0,25,q(1));
    expect(projectInsertOwnSpeed(half,q(2000000000000001,1000000000000000)).endFrame).toBe(12);
    expect(projectInsertOwnSpeed(half,q(1999999999999999,1000000000000000)).endFrame).toBe(13);
    expect(projectInsertOwnSpeed(half,q(2)).endFrame).toBe(13);
    expect(projectInsertOwnSpeed({startFrame:0,exposure:q(1,Number.MAX_SAFE_INTEGER)},q(16)).endFrame).toBe(1);
  });
  it('bounds the final integer and saved exposure, not an unsaved quotient',()=>{
    const maximum={startFrame:0,exposure:q(Number.MAX_SAFE_INTEGER)};
    expect(projectInsertOwnSpeed(maximum,q(1)).endFrame).toBe(Number.MAX_SAFE_INTEGER);
    expect(()=>projectInsertOwnSpeed(maximum,q(1,10))).toThrow(SequenceError);
    expect(()=>registerInsertOwnSpeed(0,Number.MAX_SAFE_INTEGER,q(16))).toThrow(SequenceError);
  });
  it('rejects invalid own bounds and overflow',()=>{
    expect(()=>registerInsertOwnSpeed(2,2,q(1))).toThrow(SequenceError);
    expect(()=>projectInsertOwnSpeed({startFrame:0,exposure:q(-1)},q(1))).toThrow(SequenceError);
    expect(()=>projectInsertOwnSpeed({startFrame:Number.MAX_SAFE_INTEGER,exposure:q(1)},q(1))).toThrow(SequenceError);
    expect(()=>projectInsertOwnSpeed({startFrame:0,exposure:q(1)},q(17))).toThrow(SequenceError);
  });
});
