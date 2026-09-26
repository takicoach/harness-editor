import { describe, expect, it } from 'vitest';
import { rational as r } from '../../core/sequence/time';
import { sampleInVideoSourceWindow } from './videoSourceWindow';

const samples = [0, 3, 1, 2, 6, 4, 5].map((frame, index) => ({identity:{sample:index,pts:r(frame,30),duration:r(1,30)}}));
const window = {start:r(2,30),end:r(5,30)};

describe('explicit source-window video selection',()=>{
  it('uses presentation time despite B-frame decode order and holds only frames intersecting the source window',()=>{
    expect(sampleInVideoSourceWindow(samples,r(0),window)).toBe(3); // PTS2, not sample0.
    expect(sampleInVideoSourceWindow(samples,r(3,30),window)).toBe(1);
    expect(sampleInVideoSourceWindow(samples,r(5,30),window)).toBe(5); // PTS4, not PTS5.
    expect(sampleInVideoSourceWindow(samples,r(100),window)).toBe(5);
  });
  it('allows a cut through one frame interval without admitting its neighbours',()=>{
    const subframe={start:r(45,600),end:r(49,600)}; // Both lie inside presentation frame2.
    for(const time of [r(0),subframe.start,r(47,600),subframe.end,r(1)])expect(sampleInVideoSourceWindow(samples,time,subframe)).toBe(3);
  });
  it('treats exact boundaries as half-open without floating-point conversion',()=>{
    const exact={start:r(1001,30000),end:r(2002,30000)},list=[0,1,2].map(i=>({identity:{sample:i,pts:r(i*1001,30000),duration:r(1001,30000)}}));
    expect(sampleInVideoSourceWindow(list,exact.start,exact)).toBe(1);
    expect(sampleInVideoSourceWindow(list,exact.end,exact)).toBe(1);
  });
  it('does not fill a hole inside the window merely because hold-at-EOF is enabled',()=>{
    const hole=[{identity:{sample:0,pts:r(0),duration:r(1)}},{identity:{sample:1,pts:r(2),duration:r(1)}}];
    expect(()=>sampleInVideoSourceWindow(hole,r(3,2),{start:r(0),end:r(4)},true)).toThrow(/指定時刻/);
    expect(sampleInVideoSourceWindow(hole,r(7,2),{start:r(0),end:r(4)},true)).toBe(1);
    expect(()=>sampleInVideoSourceWindow(hole,r(7,2),{start:r(0),end:r(4)})).toThrow(/指定時刻/);
  });
  it('rejects empty/nonintersecting windows instead of showing an outside frame',()=>{
    for(const bounds of [{start:r(0),end:r(0)},{start:r(-1),end:r(1)},{start:r(1),end:r(2)},{start:r(1),end:{num:1,den:0}}]){
      expect(()=>sampleInVideoSourceWindow(samples,r(1),bounds,true)).toThrow();
    }
  });
  it('does not mistake the last intersecting sample for the end of the whole media',()=>{
    const withLaterSample=[{identity:{sample:0,pts:r(0),duration:r(1)}},{identity:{sample:1,pts:r(2),duration:r(1)}}];
    // The saved cut ends inside a media hole; a later sample still exists.
    // This remains an internal hole even though only sample0 intersects the cut.
    expect(()=>sampleInVideoSourceWindow(withLaterSample,r(5,4),{start:r(0),end:r(3,2)},true)).toThrow(/指定時刻/);
    expect(sampleInVideoSourceWindow(withLaterSample,r(13,4),{start:r(0),end:r(4)},true)).toBe(1);
  });
  it('does not change index identities or requested source bounds',()=>{
    const before=JSON.stringify({samples,window});sampleInVideoSourceWindow(samples,r(100),window);
    expect(JSON.stringify({samples,window})).toBe(before);
  });
  it('matches an independent integer-grid oracle for 5250 windows and requests',()=>{
    const order=[0,3,1,2,6,4,5,9,7,8],index=order.map((frame,sample)=>({identity:{sample,pts:r(frame,30),duration:r(1,30)}}));
    let checked=0;
    for(let start=0;start<20;start++)for(let end=start+1;end<=20;end++)for(let time=-2;time<=22;time++){
      // Integer half-frame units: endpoints determine the first/last eligible
      // interval directly, independently of the selector's Rational operations.
      const expectedFrame=Math.max(Math.floor(start/2),Math.min(Math.ceil(end/2)-1,Math.floor(time/2)));
      expect(sampleInVideoSourceWindow(index,r(time,60),{start:r(start,60),end:r(end,60)})).toBe(order.indexOf(expectedFrame));checked++;
    }
    expect(checked).toBe(5250);
  });
});
