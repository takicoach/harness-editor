import {expect,it} from 'vitest';
import {CLIP_SEEK_CUT_REASON,clipSeekTarget} from './clipSeek';

const clip={startFrame:100,durationFrames:100};   // 可視区間 [100,200)

it('区間の外にいるときは可視フレームの中点へ送る',()=>{
  expect(clipSeekTarget(clip,0,null)).toEqual({frame:150});
  expect(clipSeekTarget(clip,900,null)).toEqual({frame:150});
});
it('すでに区間の中にいるときは動かさない（理由も出さない）',()=>{
  expect(clipSeekTarget(clip,150,null)).toEqual({frame:null,reason:''});
  expect(clipSeekTarget(clip,100,null)).toEqual({frame:null,reason:''});
  expect(clipSeekTarget(clip,199,null)).toEqual({frame:null,reason:''});
});
it('長さ 1 の字幕は先頭へ送る',()=>{
  expect(clipSeekTarget({startFrame:100,durationFrames:1},0,null)).toEqual({frame:100});
});
it('一部だけカットされていれば、残った可視フレームだけで中点を測る',()=>{
  const pieces=[{startFrame:0,endFrame:120},{startFrame:180,endFrame:300}];
  expect(clipSeekTarget(clip,0,pieces)).toEqual({frame:180});
});
it('完全にカットされていれば理由つきで送らない',()=>{
  expect(clipSeekTarget(clip,0,[{startFrame:0,endFrame:50}])).toEqual({frame:null,reason:CLIP_SEEK_CUT_REASON});
  expect(CLIP_SEEK_CUT_REASON).toBe('この字幕はカットされた部分にあります。カットを戻すと表示できます。');
});
it('pieces が null なら全域を可視として扱う',()=>{
  expect(clipSeekTarget({startFrame:0,durationFrames:60},500,null)).toEqual({frame:30});
});
