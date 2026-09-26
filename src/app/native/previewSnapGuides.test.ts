import {describe,it,expect} from 'vitest';
import {SNAP_LINES,snapAxis} from '../preview/previewSnap';
import {snapPlacement,PREVIEW_SNAP_LINES,PREVIEW_SNAP_TOLERANCE} from './previewSnapGuides';

describe('snapPlacement',()=>{
  it('中央と三分割にだけ吸着する（端 ±1 は対象外）',()=>{
    expect(PREVIEW_SNAP_LINES).toEqual([-1/3,0,1/3]);
    expect(snapPlacement(.01,-.34)).toEqual({x:0,y:-1/3,guideX:0,guideY:-1/3});
    expect(snapPlacement(.99,.99)).toEqual({x:.99,y:.99,guideX:null,guideY:null});
  });
  it('許容は正規化差分 0.02（px ではない）',()=>{
    expect(PREVIEW_SNAP_TOLERANCE).toBe(.02);
    expect(snapPlacement(.02,0).guideX).toBe(0);
    expect(snapPlacement(.021,0).guideX).toBeNull();
  });
  it('x と y は独立に吸着する',()=>{
    expect(snapPlacement(.335,.5)).toEqual({x:1/3,y:.5,guideX:1/3,guideY:null});
  });
  it('最寄りの線を選ぶ',()=>{
    expect(snapPlacement(-1/3+.005,0).guideX).toBe(-1/3);
  });
  // 定数と判定を legacy と共有していることを固定する。native と legacy はどちらも
  // 正規化 [-1,1]（端〜端が 2）なので座標変換は挟まない。ここが割れたら吸着位置がずれる。
  it('legacy previewSnap の定数・判定をそのまま使う（座標変換なし）',()=>{
    expect(PREVIEW_SNAP_LINES).toBe(SNAP_LINES);
    for(const value of [-1,-.34,-.01,0,.02,.021,.335,.99]){
      const axis=snapAxis(value,PREVIEW_SNAP_TOLERANCE),placement=snapPlacement(value,value);
      expect(placement.x).toBe(axis.value);expect(placement.guideX).toBe(axis.line);
    }
  });
});
