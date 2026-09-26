import {expect,it} from 'vitest';
import {scrubFrame} from './scrubTarget';

it('最終フレームの手前で止める',()=>{
  expect(scrubFrame(500,300)).toBe(299);
  expect(scrubFrame(100,300)).toBe(100);
});
it('空案件では 0 に固定する（負値を通さない）',()=>{
  expect(scrubFrame(0,0)).toBe(0);
  expect(scrubFrame(120,0)).toBe(0);
  expect(scrubFrame(-5,0)).toBe(0);
});
it('負の入力は 0 へ寄せる',()=>{
  expect(scrubFrame(-12,300)).toBe(0);
});
