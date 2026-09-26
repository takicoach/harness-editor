import {expect,it} from 'vitest';
import {hoverEdgeScrollDelta} from './nativeEdgeScroll';

const rect={left:0,right:1000,top:100,bottom:400};
const at=(pointerX:number,pointerY=200,dtMs:number|null=1000/60)=>hoverEdgeScrollDelta({pointerX,pointerY,rect,gutter:132,dtMs});

it('stops outside the scroll frame in both axes',()=>{
  expect(at(990,99)).toBe(0);
  expect(at(990,401)).toBe(0);
  expect(at(-1)).toBe(0);
  expect(at(1001)).toBe(0);
});
it('never fires over the track-label gutter',()=>{
  expect(at(10)).toBe(0);
  expect(at(131)).toBe(0);
});
it('accelerates toward each edge and keeps the sign of scrollLeft',()=>{
  const right=at(999),middle=at(500);
  expect(middle).toBe(0);
  expect(right).toBeGreaterThan(0);
  expect(at(990)).toBeLessThan(right);
  expect(at(134)).toBeLessThan(0);
});
it('normalises to real time through the shared frame scale',()=>{
  expect(at(999,200,1000/30)).toBeCloseTo(at(999,200,1000/60)*2,6);
  expect(at(999,200,null)).toBeCloseTo(at(999,200,1000/60),6);
});
