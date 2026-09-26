import {expect,it} from 'vitest';
import {waveformViewport} from './waveformViewport';

it('excludes clips hidden behind the sticky labels or beyond the right edge',()=>{
  expect(waveformViewport(0,60,2,120,1000)).toBeNull();
  expect(waveformViewport(500,60,2,0,1000)).toBeNull();
  expect(waveformViewport(0,60,2,0,132)).toBeNull();
});
it('keeps the visible source position after horizontal scrolling',()=>{
  expect(waveformViewport(100,1000,2,600,1132)).toEqual({startFrame:200,frameCount:500,left:400,width:1000,bins:1000});
});
it('rounds visible edges outward by less than a frame without growing with the full clip',()=>{
  const result=waveformViewport(0,1_000_000,8,1003,1600)!;
  expect(result).toEqual({startFrame:125,frameCount:184,left:1000,width:1472,bins:1472});
  expect(result.left).toBeLessThanOrEqual(1003);expect(result.left+result.width).toBeGreaterThanOrEqual(2471);
  expect(result.width).toBeLessThan(1600-132+16);
});
it('caps backing data on large monitors and represents the complete visible interval',()=>{
  const result=waveformViewport(0,18000,.2,0,8000)!;
  expect(result).toEqual({startFrame:0,frameCount:18000,left:0,width:3600,bins:2400});
});
