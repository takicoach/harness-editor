import {describe,it,expect} from 'vitest';
import {normalizeStagePoint,beginShapeDraft,updateShapeDraft,releaseShapeDraft,shapeDraftChip,shapeDraftData,SHAPE_MIN_SPAN} from './shapeDraft';

const rect={left:100,top:50,width:640,height:360};

describe('normalizeStagePoint',()=>{
  it('合成面の実測矩形で縦横それぞれ正規化し 0..1 へ丸める',()=>{
    expect(normalizeStagePoint({x:420,y:230},rect)).toEqual({x:.5,y:.5});
    expect(normalizeStagePoint({x:0,y:0},rect)).toEqual({x:0,y:0});
    expect(normalizeStagePoint({x:9999,y:9999},rect)).toEqual({x:1,y:1});
  });
  it('縦長・横長で係数が別（非等方 scale を前提にしない）',()=>{
    const portrait={left:0,top:0,width:360,height:640};
    expect(normalizeStagePoint({x:180,y:160},portrait)).toEqual({x:.5,y:.25});
  });
  it('矩形が潰れていたら明示エラー',()=>{
    expect(()=>normalizeStagePoint({x:0,y:0},{left:0,top:0,width:0,height:100})).toThrow(RangeError);
  });
});

describe('ドラッグの下書き',()=>{
  it('rect は pointerup で完成する',()=>{
    let draft=beginShapeDraft('rect',{x:.2,y:.3});
    draft=updateShapeDraft(draft,{x:.6,y:.7});
    const released=releaseShapeDraft(draft,{x:.6,y:.7});
    expect(released.done).toBe(true);
    expect(shapeDraftData(released.draft,'#FF3B30')).toEqual({kind:'rect',x1:.2,y1:.3,x2:.6,y2:.7,color:'#FF3B30',thickness:'medium',opacity:1});
  });
  it('angle は pointerup で端点 B を水平右に置き、まだ完成しない',()=>{
    let draft=beginShapeDraft('angle',{x:.5,y:.5});
    draft=updateShapeDraft(draft,{x:.5,y:.2});
    const released=releaseShapeDraft(draft,{x:.5,y:.2});
    expect(released.done).toBe(false);
    expect(released.draft.stage).toBe('vertexB');
    expect(released.draft.x3).toBeCloseTo(.8,6);   // |頂点→A| ぶん水平右
    expect(released.draft.y3).toBeCloseTo(.5,6);
  });
  it('angle は 2 回目のクリックで端点 B が確定して完成する',()=>{
    let draft=releaseShapeDraft(updateShapeDraft(beginShapeDraft('angle',{x:.5,y:.5}),{x:.5,y:.2}),{x:.5,y:.2}).draft;
    draft=updateShapeDraft(draft,{x:.9,y:.6});
    const released=releaseShapeDraft(draft,{x:.9,y:.6});
    expect(released.done).toBe(true);
    expect(shapeDraftData(released.draft,'#FF3B30')).toMatchObject({kind:'angle',x1:.5,y1:.5,x2:.5,y2:.2,x3:.9,y3:.6});
  });
  it('angle 以外の完成データに x3,y3 を残さない',()=>{
    const data=shapeDraftData({kind:'triangle',x1:.1,y1:.1,x2:.4,y2:.5,x3:.9,y3:.9,stage:'drag'},'#FFFFFF');
    expect('x3' in data).toBe(false);
    expect('y3' in data).toBe(false);
  });
  it('動かさないドラッグは既定サイズで置く',()=>{
    const draft=beginShapeDraft('ellipse',{x:.5,y:.5});
    const released=releaseShapeDraft(draft,{x:.5+SHAPE_MIN_SPAN/2,y:.5});
    expect(released.done).toBe(true);
    expect(shapeDraftData(released.draft,'#FF3B30')).toMatchObject({x1:.25,y1:.25,x2:.75,y2:.75});
  });
  it('レビュー Minor 2: 端点 B が頂点や A と実質一致（実寸で数px以内）なら完成させず据え置く',()=>{
    const resolution={width:1920,height:1080};
    let waiting=releaseShapeDraft(updateShapeDraft(beginShapeDraft('angle',{x:.5,y:.5}),{x:.5,y:.2}),{x:.5,y:.2}).draft;
    expect(waiting.stage).toBe('vertexB');
    // 頂点（x1,y1）とほぼ同じ点で確定しようとする → 実寸 4px 未満なので据え置く
    const nearVertex=releaseShapeDraft(waiting,{x:.5+1/resolution.width,y:.5},resolution);
    expect(nearVertex.done).toBe(false);
    expect(nearVertex.draft).toEqual(waiting);
    // A（x2,y2）とほぼ同じ点で確定しようとする → こちらも据え置く
    const nearA=releaseShapeDraft(waiting,{x:.5,y:.2+1/resolution.height},resolution);
    expect(nearA.done).toBe(false);
    expect(nearA.draft).toEqual(waiting);
    // 実寸で十分離れていれば従来どおり完成する
    const far=releaseShapeDraft(waiting,{x:.9,y:.6},resolution);
    expect(far.done).toBe(true);
  });
});

describe('shapeDraftChip',()=>{
  it('矩形は実寸 px、線は長さ、角度モードは度を出す',()=>{
    expect(shapeDraftChip({kind:'rect',x1:.25,y1:.25,x2:.75,y2:.75,stage:'drag'},{width:640,height:360})).toBe('320 × 180 px');
    expect(shapeDraftChip({kind:'line',x1:0,y1:0,x2:.5,y2:0,stage:'drag'},{width:640,height:360})).toBe('320 px');
    expect(shapeDraftChip({kind:'angle',x1:.5,y1:.5,x2:.5,y2:.25,x3:.75,y3:.5,stage:'vertexB'},{width:640,height:360})).toBe('90.0°');
  });
});
