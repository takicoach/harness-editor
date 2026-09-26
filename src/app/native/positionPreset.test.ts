import {expect,it} from 'vitest';
import {POSITION_PRESET_LABELS,applyPositionPreset} from './positionPreset';
import {POSITION_PRESETS} from '../preview/positionPresets';

it('returns the legacy normalised value for every cell',()=>{
  for(let row=0;row<3;row++)for(let column=0;column<3;column++)
    expect(applyPositionPreset(row as 0|1|2,column as 0|1|2)).toEqual(POSITION_PRESETS[row]![column]);
});
it('centres on the middle cell',()=>{
  expect(applyPositionPreset(1,1)).toEqual({x:0,y:-0.5});
});
it('names all nine cells in Japanese',()=>{
  expect(POSITION_PRESET_LABELS.flat()).toEqual(['左上','中央上','右上','左中央','中央','右中央','左下','中央下','右下']);
});
it('never returns a shared mutable object',()=>{
  const a=applyPositionPreset(0,0);a.x=99;
  expect(applyPositionPreset(0,0).x).toBe(-1);
});
