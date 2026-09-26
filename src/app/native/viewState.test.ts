/** @vitest-environment jsdom */
import {expect,it} from 'vitest';
import {readNativeView,writeNativeView} from './viewState';

it('カラムの折りたたみ状態は保存・復元される',()=>{
  writeNativeView('p1',{...readNativeView('p1'),leftHidden:true,rightHidden:true});
  expect(readNativeView('p1')).toMatchObject({leftHidden:true,rightHidden:true});
});

it('旧 tab 値を新しい 4 タブへ移行する',()=>{
  for(const [before,after] of [['assets','video'],['music','bgm'],['transcript','video'],['captions','video'],['script','video'],['なんでもない','video']] as const){
    sessionStorage.setItem('harness-native-view:p2',JSON.stringify({tab:before}));
    expect(readNativeView('p2').tab).toBe(after);
  }
});
it('新しい 4 タブはそのまま復元する',()=>{
  for(const tab of ['video','image','bgm','se'] as const){
    sessionStorage.setItem('harness-native-view:p3',JSON.stringify({tab}));
    expect(readNativeView('p3').tab).toBe(tab);
  }
});
it('詰めるの既定は ON で、保存と読み出しを往復する',()=>{
  expect(readNativeView('p1').ripple).toBe(true);
  writeNativeView('p1',{...readNativeView('p1'),ripple:false});
  expect(readNativeView('p1').ripple).toBe(false);
  sessionStorage.setItem('harness-native-view:p2',JSON.stringify({mode:'edit'}));
  expect(readNativeView('p2').ripple).toBe(true);   // 旧い保存に無ければ ON
});
it('タイムライン行の自動（bottomAuto）は既定 true、false は往復する',()=>{
  expect(readNativeView('p-bottom-auto').bottomAuto).toBe(true);
  writeNativeView('p-bottom-auto',{...readNativeView('p-bottom-auto'),bottom:300,bottomAuto:false});
  expect(readNativeView('p-bottom-auto').bottomAuto).toBe(false);
  expect(readNativeView('p-bottom-auto').bottom).toBe(300);
});
// M-1: 旧データ（bottomAuto を持たない）に bottom があるなら、それはドラッグで決めた高さ。
// 既定 true に落とすと、その高さを 1 回だけ自動（窓の 34%）で上書きして捨てる。
it('bottomAuto の無い旧データに保存済みの bottom があれば手動（false）として読む',()=>{
  sessionStorage.setItem('harness-native-view:p-legacy-bottom',JSON.stringify({mode:'edit',bottom:300}));
  expect(readNativeView('p-legacy-bottom').bottomAuto).toBe(false);
  expect(readNativeView('p-legacy-bottom').bottom).toBe(300);
  // bottom も無い（本当に未設定）なら既定の自動。不正な値も自動へ落とす。
  sessionStorage.setItem('harness-native-view:p-legacy-none',JSON.stringify({mode:'edit'}));
  expect(readNativeView('p-legacy-none').bottomAuto).toBe(true);
  sessionStorage.setItem('harness-native-view:p-legacy-bad',JSON.stringify({mode:'edit',bottom:'300'}));
  expect(readNativeView('p-legacy-bad').bottomAuto).toBe(true);
});
it('調整タブの群の開閉（inspectorOpen）を往復し、不正な値は捨てる',()=>{
  expect(readNativeView('p-insp').inspectorOpen).toEqual({});
  writeNativeView('p-insp',{...readNativeView('p-insp'),inspectorOpen:{'telop:look':true,'video:place':false}});
  expect(readNativeView('p-insp').inspectorOpen).toEqual({'telop:look':true,'video:place':false});
  sessionStorage.setItem('harness-native-view:p-insp2',JSON.stringify({inspectorOpen:{'telop:look':'yes',ok:true}}));
  expect(readNativeView('p-insp2').inspectorOpen).toEqual({ok:true});
});
