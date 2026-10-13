import {expect,it} from 'vitest';
import {applySequenceCommand} from '../../core/sequence/commands';
import {fixture} from '../../core/sequence/fixtures';
import {rippleTrimPlan} from '../../core/sequence/rippleTrim';
import {livePendingTrim,pendingTrimFrom} from './pendingTrim';
const doc=()=>applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
const left=(d:ReturnType<typeof doc>)=>d.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
it('draws the committed geometry: end trims keep the start, plain start trims move it, a ripple close keeps the clip where it began',()=>{
  const d=doc(),clip=left(d);
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'end',frame:120,ripple:false,plan:{kind:'plain'}})).toMatchObject({startFrame:0,durationFrames:120,sourceOffsetFrames:0,revision:d.revision});
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'start',frame:30,ripple:false,plan:{kind:'plain'}})).toMatchObject({startFrame:30,durationFrames:120,sourceOffsetFrames:30});
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'start',frame:30,ripple:true,plan:{kind:'close',startFrame:0,endFrame:30}})).toMatchObject({startFrame:0,durationFrames:120,sourceOffsetFrames:30});
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'end',frame:0,ripple:false,plan:undefined})).toBeNull();
});
it('belongs only to the document, revision and session it was made from',()=>{
  const d=doc(),pending=pendingTrimFrom({sessionId:'s',document:d,clip:left(d),edge:'end',frame:120,ripple:false,plan:undefined})!;
  expect(livePendingTrim(pending,d,'s')).toBe(pending);
  expect(livePendingTrim(pending,{...d,revision:d.revision+1},'s')).toBeNull();
  expect(livePendingTrim(pending,{...d,id:'other'},'s')).toBeNull();
  expect(livePendingTrim(pending,d,'reloaded')).toBeNull();
  expect(livePendingTrim(pending,{...d,clips:d.clips.filter(c=>c.id!==pending.clipId)},'s')).toBeNull();
});
it('keeps the ripple plan only when the trim is sent as a ripple',()=>{
  const d=doc(),clip=left(d),plan={kind:'close' as const,startFrame:120,endFrame:150};
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'end',frame:120,ripple:true,plan})!.plan).toEqual(plan);
  expect(pendingTrimFrom({sessionId:'s',document:d,clip,edge:'end',frame:120,ripple:false,plan})!.plan).toBeUndefined();
});
it('a start-edge join pulled past the left neighbour lands on its start, where the commit puts the joined clip',()=>{
  // 0〜100・100〜200・200〜300 の3片。3片目の開始端を 50 まで引くと、左隣（100 始まり）と1本に戻り 100 で止まる。
  const once=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:100});
  const d=applySequenceCommand(once,{type:'split',clipIds:[once.clips.find(c=>c.trackId==='v1'&&c.startFrame===100)!.id],frame:200});
  const third=d.clips.find(c=>c.trackId==='v1'&&c.startFrame===200)!,command={type:'trim' as const,clipId:third.id,edge:'start' as const,frame:50,ripple:true};
  const plan=rippleTrimPlan(d,command);expect(plan.kind).toBe('join');
  const pending=pendingTrimFrom({sessionId:'s',document:d,clip:third,edge:'start',frame:50,ripple:true,plan})!;
  const joined=applySequenceCommand(d,command).clips.find(c=>c.trackId==='v1'&&c.startFrame===100)!;
  expect([pending.startFrame,pending.durationFrames]).toEqual([joined.startFrame,joined.durationFrames]);
  expect(pending.sourceOffsetFrames).toBe(-100);
});
