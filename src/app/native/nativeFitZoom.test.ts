import {expect,it} from 'vitest';
import {nativeFitZoom,nativeMinZoom} from './nativeFitZoom';
import {MAX_PX_PER_FRAME,MIN_PX_PER_FRAME} from '../timeline/timelineGeometry';

it('fits the whole sequence into the width that remains right of the 132px gutter',()=>{
  // 1000 - 132 = 868px で 868 フレーム → ちょうど 1.0
  expect(nativeFitZoom(868,1000)).toBe(1);
  expect(nativeFitZoom(434,1000)).toBe(2);
});
it('clamps to the shared zoom range instead of returning an unusable value',()=>{
  expect(nativeFitZoom(1,1000)).toBe(MAX_PX_PER_FRAME);
  expect(nativeFitZoom(10_000_000,1000)).toBe(MIN_PX_PER_FRAME);
});
it('returns null when the fit cannot be computed, so the caller keeps the current zoom',()=>{
  expect(nativeFitZoom(0,1000)).toBeNull();
  expect(nativeFitZoom(868,0)).toBeNull();
  expect(nativeFitZoom(868,132)).toBeNull();
  expect(nativeFitZoom(Number.NaN,1000)).toBeNull();
});
it('caps the slider floor below MAX_PX_PER_FRAME for short sequences, so min stays below max',()=>{
  // 120 frames in a 1600px viewport: fit = (1600-132)/120 = 12.23..., clamped to MAX (12).
  expect(nativeFitZoom(120,1600)).toBe(MAX_PX_PER_FRAME);
  expect(nativeMinZoom(120,1600)).toBe(MAX_PX_PER_FRAME/2);
  expect(nativeMinZoom(120,1600)).toBeLessThan(MAX_PX_PER_FRAME);
});
it('leaves the slider floor untouched when fit does not reach MAX',()=>{
  expect(nativeMinZoom(868,1000)).toBe(1);
});
