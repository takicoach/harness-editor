import {describe,it,expect} from 'vitest';
import type {PreviewRect} from './previewManipulation';
import {groupBounds,applyGroupMove,applyGroupScale,type GroupMember} from './multiSelectDrag';

const viewport:PreviewRect={x:0,y:0,width:640,height:360};
// 角は viewport と同じ原点で作る（corners と viewport の原点一致が本モジュールの契約）。
const memberIn=(vp:PreviewRect)=>(clipId:string,x:number,y:number,scale=1,half={x:40,y:30}):GroupMember=>{
  const cx=vp.x+(1+x)*vp.width/2,cy=vp.y+(1+y)*vp.height/2;
  return {clipId,placement:{x,y,scale,rotation:0,flipH:false,flipV:false},
    corners:{nw:{x:cx-half.x,y:cy-half.y},ne:{x:cx+half.x,y:cy-half.y},se:{x:cx+half.x,y:cy+half.y},sw:{x:cx-half.x,y:cy+half.y}}};
};
const member=memberIn(viewport);

describe('groupBounds',()=>{
  it('全員の角を含む外接矩形',()=>{
    expect(groupBounds([member('a',-.5,0),member('b',.5,0)])).toEqual({x:120,y:150,width:400,height:60});
  });
  it('1 件でも外接矩形を返す',()=>{
    expect(groupBounds([member('a',0,0)])).toEqual({x:280,y:150,width:80,height:60});
  });
  it('空の選択は拒否する',()=>{
    expect(()=>groupBounds([])).toThrow(RangeError);
  });
});

describe('applyGroupMove',()=>{
  it('全員へ同じ移動量を加える',()=>{
    const next=applyGroupMove([member('a',-.5,0),member('b',.5,0)],viewport,{x:32,y:18});
    expect(next.get('a')).toMatchObject({x:-.5+.1,y:.1});
    expect(next.get('b')).toMatchObject({x:.5+.1,y:.1});
  });
});

describe('applyGroupScale',()=>{
  it('外接矩形の中心を基準に同じ倍率を適用する',()=>{
    const members=[member('a',-.5,0),member('b',.5,0)];
    const next=applyGroupScale(members,viewport,2);
    expect(next.get('a')!.scale).toBe(2);
    expect(next.get('b')!.scale).toBe(2);
    // 中心（x=0）から見た距離が 2 倍になる
    expect(next.get('a')!.x).toBeCloseTo(-1,6);
    expect(next.get('b')!.x).toBeCloseTo(1,6);
  });
  it('倍率 1 は何も変えない',()=>{
    const members=[member('a',-.5,0),member('b',.5,0)];
    const next=applyGroupScale(members,viewport,1);
    expect(next.get('a')).toEqual(members[0]!.placement);
  });
  it('0 以下の倍率は空を返す（拡縮を拒否）',()=>{
    expect(applyGroupScale([member('a',0,0)],viewport,0).size).toBe(0);
  });
  // 往復誤差の出る非 2 冪ビューポート。corners と viewport の原点が一致していないと
  // 中心の正規化がずれる（viewport.x を引き忘れると 0.1 が 0.715… になる）。
  it('原点がずれた非 2 冪ビューポートでも外接矩形の中心が基準になる',()=>{
    const stage:PreviewRect={x:337.5,y:21.25,width:1097.5,height:617.75};
    const offset=memberIn(stage);
    const members=[offset('a',-.4,0),offset('b',.6,0)];
    const next=applyGroupScale(members,stage,1.5);
    // 中心の正規化 x は (-.4+.6)/2 = .1、y は 0。
    expect(next.get('a')!.x).toBeCloseTo(.1+(-.4-.1)*1.5,10);
    expect(next.get('b')!.x).toBeCloseTo(.1+(.6-.1)*1.5,10);
    expect(next.get('a')!.y).toBeCloseTo(0,10);
    expect(next.get('b')!.y).toBeCloseTo(0,10);
  });
});
