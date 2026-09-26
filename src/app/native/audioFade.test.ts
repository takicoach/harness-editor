import {expect,it} from 'vitest';
import {fadeFrames,fadeSeconds} from './audioFade';
import {rational as r} from '../../core/sequence/time';

it('shows frames as seconds with two decimals',()=>{
  expect(fadeSeconds(30,r(30))).toBe(1);
  expect(fadeSeconds(45,r(30))).toBe(1.5);
  expect(fadeSeconds(1,r(30))).toBe(0.03);
  expect(fadeSeconds(0,r(30))).toBe(0);
});
it('stores seconds as whole non-negative frames',()=>{
  expect(fadeFrames(1,r(30))).toBe(30);
  expect(fadeFrames(0.5,r(30))).toBe(15);
  expect(fadeFrames(0.51,r(30))).toBe(15);        // 端数は切り捨て（尺を超えない側へ倒す）
  expect(fadeFrames(-3,r(30))).toBe(0);
  expect(fadeFrames(Number.NaN,r(30))).toBe(0);
});
it('round-trips a value the user typed',()=>{
  expect(fadeSeconds(fadeFrames(1.5,r(30)),r(30))).toBe(1.5);
});
