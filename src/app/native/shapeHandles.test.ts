import {describe,it,expect} from 'vitest';
import {shapeHandlePoints,shapeHandleViewport,moveShapeHandle,shapeKindChange} from './shapeHandles';
import type {ShapeData} from './shapeDraft';

const viewport={x:100,y:50,width:640,height:360};
const identity={x:0,y:0,scale:1,rotation:0,flipH:false,flipV:false};
const line:ShapeData={kind:'line',x1:.25,y1:.5,x2:.75,y2:.5,color:'#FF3B30',thickness:'medium',opacity:1};
const angle:ShapeData={kind:'angle',x1:.5,y1:.5,x2:.5,y2:.25,x3:.75,y3:.5,color:'#FF3B30',thickness:'medium',opacity:1};

describe('shapeHandlePoints',()=>{
  it('line は 2 点を client 座標で返す',()=>{
    expect(shapeHandlePoints(line,viewport)).toEqual({p1:{x:260,y:230},p2:{x:580,y:230}});
  });
  it('angle は頂点・A・B の 3 点',()=>{
    const points=shapeHandlePoints(angle,viewport);
    expect(Object.keys(points).sort()).toEqual(['p1','p2','p3']);
    expect(points.p3).toEqual({x:580,y:230});
  });
  it('rect・ellipse・triangle は端点ハンドルを持たない（箱操作）',()=>{
    for(const kind of ['rect','ellipse','triangle'] as const)
      expect(shapeHandlePoints({...line,kind},viewport)).toEqual({});
  });
});

describe('shapeHandleViewport',()=>{
  it('既定配置ではビューポートをそのまま返す',()=>{
    expect(shapeHandleViewport(viewport,identity)).toEqual(viewport);
  });
  it('レイヤーの位置・拡縮を畳んだ矩形を返す',()=>{
    const folded=shapeHandleViewport(viewport,{...identity,x:.5,scale:.5})!;
    // 正規化 .5 は合成面の中心。位置 +.5（半幅の半分）ぶん右へずれる。
    expect(folded.x+folded.width*.5).toBeCloseTo(100+640*.5+640*.25,9);
    expect(folded.width).toBe(320);expect(folded.height).toBe(180);
    expect(folded.y+folded.height*.5).toBeCloseTo(50+180,9);
  });
  it('回転・反転・非正の拡縮は端点操作の対象外',()=>{
    for(const placement of [{rotation:5},{flipH:true},{flipV:true},{scale:0}])
      expect(shapeHandleViewport(viewport,{...identity,...placement})).toBeNull();
  });
  it('丸め誤差程度の極小回転は矩形として扱う',()=>{
    expect(shapeHandleViewport(viewport,{...identity,rotation:1e-9})).toEqual(viewport);
    expect(shapeHandleViewport(viewport,{...identity,rotation:-1e-9})).toEqual(viewport);
    expect(shapeHandleViewport(viewport,{...identity,rotation:1e-3})).toBeNull();
  });
});

describe('moveShapeHandle',()=>{
  it('掴んだ端点だけを動かす',()=>{
    const moved=moveShapeHandle(line,'p2',{x:100+640*.9,y:50+360*.2},viewport);
    expect(moved).toMatchObject({x1:.25,y1:.5,x2:.9,y2:.2});
  });
  it('angle の p3 は x3,y3 を動かす',()=>{
    const moved=moveShapeHandle(angle,'p3',{x:100+640*.1,y:50+360*.9},viewport);
    expect(moved).toMatchObject({x3:.1,y3:.9,x2:.5,y2:.25});
  });
  it('0..1 の外へは出さない',()=>{
    expect(moveShapeHandle(line,'p1',{x:-9999,y:-9999},viewport)).toMatchObject({x1:0,y1:0});
  });
  it('辺の長さ 0 になる移動は拒否して元の値を返す',()=>{
    expect(moveShapeHandle(angle,'p2',{x:100+640*.5,y:50+360*.5},viewport)).toEqual(angle);
  });
  it('resolution を渡すと実寸数 px の退化も拒否する（描画と同じガード）',()=>{
    const resolution={width:1920,height:1080};
    const near={x:100+640*(.5+1/1920),y:50+360*.5};
    expect(moveShapeHandle(angle,'p2',near,viewport,resolution)).toEqual(angle);
    expect(moveShapeHandle(angle,'p2',near,viewport)).not.toEqual(angle);
  });
});

describe('shapeKindChange',()=>{
  it('angle へ変えると端点 B を x2,y2 の長さぶん水平右に初期化する',()=>{
    const changed=shapeKindChange(line,'angle');
    expect(changed.kind).toBe('angle');
    expect(changed.x3).toBeCloseTo(.75,6);
    expect(changed.y3).toBeCloseTo(.5,6);
  });
  it('右端の頂点でも端点 B が頂点に重ならない',()=>{
    const changed=shapeKindChange({...line,x1:1,y1:.5,x2:.5,y2:.5},'angle');
    expect(changed.x3).toBeCloseTo(.5,6);expect(changed.y3).toBeCloseTo(.5,6);
  });
  it('angle から他へ変えると x3,y3 を捨てる',()=>{
    const changed=shapeKindChange(angle,'rect');
    expect('x3' in changed).toBe(false);
    expect('y3' in changed).toBe(false);
  });
  it('angle 同士・非 angle 同士は x3,y3 の扱いを変えない',()=>{
    expect(shapeKindChange(line,'triangle')).toEqual({...line,kind:'triangle'});
    expect(shapeKindChange(angle,'angle')).toEqual(angle);
  });
});
