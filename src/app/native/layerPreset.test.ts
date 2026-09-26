import {expect,it} from 'vitest';
import {LAYER_POSITION_PRESETS} from '../preview/layerPresets';
import {applyLayerPreset} from './layerPreset';
import {SNAP_LINES} from '../preview/previewSnap';
import {POSITION_PRESETS} from '../preview/positionPresets';

it('9 マスすべてを三分割の座標で返す',()=>{
  const third=1/3;
  const expected=[
    [{x:-third,y:-third},{x:0,y:-third},{x:third,y:-third}],
    [{x:-third,y:0},{x:0,y:0},{x:third,y:0}],
    [{x:-third,y:third},{x:0,y:third},{x:third,y:third}],
  ];
  for(let row=0;row<3;row++)for(let column=0;column<3;column++)
    expect(applyLayerPreset(row as 0|1|2,column as 0|1|2)).toEqual(expected[row]![column]);
});
it('上段が y=-1/3（sceneRenderer の +y は下向き）',()=>{
  expect(applyLayerPreset(0,1).y).toBeLessThan(0);
  expect(applyLayerPreset(2,1).y).toBeGreaterThan(0);
});
it('ドラッグの吸着線と同じ値を使う',()=>{
  expect([...new Set(LAYER_POSITION_PRESETS.flat().map(p=>p.x))].sort((a,b)=>a-b)).toEqual([...SNAP_LINES].sort((a,b)=>a-b));
  expect([...new Set(LAYER_POSITION_PRESETS.flat().map(p=>p.y))].sort((a,b)=>a-b)).toEqual([...SNAP_LINES].sort((a,b)=>a-b));
});
it('字幕用のプリセット（下端基準）とは別物である',()=>{
  expect(applyLayerPreset(1,1)).not.toEqual(POSITION_PRESETS[1]![1]);
  expect(POSITION_PRESETS[1]![1]).toEqual({x:0,y:-0.5});
});
it('共有の定数を書き換えない',()=>{
  const a=applyLayerPreset(0,0);a.x=99;
  expect(applyLayerPreset(0,0).x).toBeCloseTo(-1/3,12);
});
