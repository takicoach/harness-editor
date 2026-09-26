/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {loadTrackColors,saveTrackColors} from './trackColor';
afterEach(()=>localStorage.clear());

it('未保存は空',()=>{expect(loadTrackColors('p','d')).toEqual({});});
it('保存と読み出しを往復し、案件と文書で分ける',()=>{
  saveTrackColors('p','d',{t1:'--track-jimaku'});
  expect(loadTrackColors('p','d')).toEqual({t1:'--track-jimaku'});
  expect(loadTrackColors('p','other')).toEqual({});
});
it('知らないトークンは捨てる',()=>{
  localStorage.setItem('harness-native-track-colors:p:d',JSON.stringify({t1:'--track-jimaku',t2:'red',t3:42}));
  expect(loadTrackColors('p','d')).toEqual({t1:'--track-jimaku'});
});
it('空にすると鍵ごと消す',()=>{
  saveTrackColors('p','d',{t1:'--track-se'});saveTrackColors('p','d',{});
  expect(localStorage.getItem('harness-native-track-colors:p:d')).toBeNull();
});
