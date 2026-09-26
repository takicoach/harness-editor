import {describe,it,expect} from 'vitest';
import {safeAreaBoxes} from './safeArea';

describe('safeAreaBoxes',()=>{
  it('横動画は 5% インセット枠だけ',()=>{
    expect(safeAreaBoxes({width:1920,height:1080})).toEqual({safe:{left:.05,top:.05,width:.9,height:.9},band:null});
  });
  it('縦動画は下 18% の帯も返す',()=>{
    expect(safeAreaBoxes({width:1080,height:1920})).toEqual({safe:{left:.05,top:.05,width:.9,height:.9},band:{left:0,top:.82,width:1,height:.18}});
  });
  it('正方形は縦動画扱いにしない',()=>{
    expect(safeAreaBoxes({width:1000,height:1000}).band).toBeNull();
  });
});
