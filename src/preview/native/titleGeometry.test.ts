import {expect,it} from 'vitest';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import type {ClipVisual} from '../../core/sequence/model';
import {titleGeometryIssue} from './titleGeometry';

const base=():ClipVisual=>({layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]});
it('keeps old implicit inner animation unsupported and accepts the static native-added title',()=>{
  expect(titleGeometryIssue(undefined)).toBe('inner-animation');expect(titleGeometryIssue(base())).toBe('inner-animation');
  expect(titleGeometryIssue({...base(),enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}})).toBeUndefined();
  // A single explicit outer none also disables the inner renderer animation.
  expect(titleGeometryIssue({...base(),enter:{kind:'none',frames:0}})).toBeUndefined();
});
it.each(['enter','exit'] as const)('rejects evaluated %s animation rather than measuring its transient box',edge=>{
  expect(titleGeometryIssue({...base(),[edge]:{kind:'fade',frames:8}})).toBe('animation');
});
