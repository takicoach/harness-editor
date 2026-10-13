/** @vitest-environment jsdom */
// 文言は 2026-10-06 決定（設計 §2）: 本文1文＋［コピーして使う］［このまま使う］、「今後この場所では出さない」はその場の選択。
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NativeSlowMediaAdvice,slowMediaMessage} from './NativeSlowMediaAdvice';
import {MAX_COPY_ITEMS} from '../../shared/mediaCopy';
afterEach(cleanup);
const target=(assetId:string,canRemember?:false)=>({assetId,name:`${assetId}.mp4`,sizeBytes:2**30,seconds:120,...(canRemember===false?{canRemember}:{})});
const handlers=()=>({onCopy:vi.fn(),onKeepOnce:vi.fn(),onKeepAlways:vi.fn()});
it('says where the asset is and what copying gains, with the estimate, and counts the unmeasured',()=>{
  render(<NativeSlowMediaAdvice advice={{targets:[{assetId:'a',name:'a.mp4',sizeBytes:29*2**30,seconds:900}],totalBytes:29*2**30,totalSeconds:900,unmeasured:2}} disabled={false} {...handlers()}/>);
  expect(screen.getByText('この素材は読み込みに時間がかかる場所にあります（確認に約15分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。')).toBeTruthy();
  expect(screen.getByText('まだ読み取りの速さを測れていない素材が 2 本あります。')).toBeTruthy();expect(screen.getByText('a.mp4')).toBeTruthy();
});
it('gives the count and the total (rounded up like the copy dialog) when there are several',()=>{
  render(<NativeSlowMediaAdvice advice={{targets:[target('a'),{...target('b'),sizeBytes:1}],totalBytes:2**30+1,totalSeconds:181,unmeasured:0}} disabled={false} {...handlers()}/>);
  expect(screen.getByText('この素材（2本・合計 1.1 GB）は読み込みに時間がかかる場所にあります（確認に約4分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。')).toBeTruthy();
  expect(screen.getByText('a.mp4（約2分）')).toBeTruthy();expect(screen.queryByText(/まだ読み取りの速さを測れていない/)).toBeNull();
});
it('offers two buttons: copy, or keep as is for this time unless "not again here" is chosen on the spot',()=>{
  const h=handlers();render(<NativeSlowMediaAdvice advice={{targets:[target('a')],totalBytes:2**30,totalSeconds:120,unmeasured:0}} disabled={false} {...h}/>);
  expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['コピーして使う','このまま使う']);
  fireEvent.click(screen.getByRole('button',{name:'コピーして使う'}));expect(h.onCopy).toHaveBeenCalledWith(['a']);
  fireEvent.click(screen.getByRole('button',{name:'このまま使う'}));expect(h.onKeepOnce).toHaveBeenCalledWith(['a']);expect(h.onKeepAlways).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:'今後この場所では出さない'}));fireEvent.click(screen.getByRole('button',{name:'このまま使う'}));
  expect(h.onKeepAlways).toHaveBeenCalledWith(['a']);expect(h.onKeepOnce).toHaveBeenCalledTimes(1);
});
it('shows nothing when no asset is expected to take long',()=>{
  const view=render(<NativeSlowMediaAdvice advice={{targets:[],totalBytes:0,totalSeconds:0,unmeasured:3}} disabled={false} {...handlers()}/>);
  expect(view.container.innerHTML).toBe('');
});
it('does not offer "今後この場所では出さない" when no drive of the targets can be told apart, and says so only once it is chosen when some can',()=>{
  const none=render(<NativeSlowMediaAdvice advice={{targets:[target('a',false)],totalBytes:2**30,totalSeconds:120,unmeasured:0}} disabled={false} {...handlers()}/>);
  expect(none.queryByRole('checkbox')).toBeNull();expect(none.getByRole('button',{name:'このまま使う'})).toBeTruthy();cleanup();
  const h=handlers(),mixed=render(<NativeSlowMediaAdvice advice={{targets:[target('a'),target('b',false)],totalBytes:2*2**30,totalSeconds:240,unmeasured:0}} disabled={false} {...h}/>);
  expect(mixed.queryByText(/ドライブを識別できない/)).toBeNull();
  fireEvent.click(mixed.getByRole('checkbox',{name:'今後この場所では出さない'}));expect(mixed.getByText('ドライブを識別できない素材（b.mp4）は、今回だけこのまま使います。')).toBeTruthy();
  fireEvent.click(mixed.getByRole('button',{name:'このまま使う'}));expect(h.onKeepAlways).toHaveBeenCalledWith(['a','b']);
});
it('keeps "このまま使う" and the choice from being pressed while recording, and lets them be pressed again when it fails',async()=>{
  let fail!:()=>void;const h={...handlers(),onKeepAlways:vi.fn(()=>new Promise<void>((_resolve,reject)=>{fail=()=>reject(new Error('x'));}))};
  render(<NativeSlowMediaAdvice advice={{targets:[target('a')],totalBytes:2**30,totalSeconds:120,unmeasured:0}} disabled={false} {...h}/>);
  const keep=()=>screen.getByRole('button',{name:'このまま使う'}) as HTMLButtonElement,choice=()=>screen.getByRole('checkbox',{name:'今後この場所では出さない'}) as HTMLInputElement;
  fireEvent.click(choice());fireEvent.click(keep());expect(keep().disabled).toBe(true);expect(choice().disabled).toBe(true);
  fireEvent.click(keep());expect(h.onKeepAlways).toHaveBeenCalledTimes(1);
  await act(async()=>{fail();});await waitFor(()=>expect(keep().disabled).toBe(false));expect(choice().disabled).toBe(false);
});
it('keeps the copy from starting while editing is locked, but still lets the advice be put away',()=>{
  const h=handlers();render(<NativeSlowMediaAdvice advice={{targets:[target('a')],totalBytes:2**30,totalSeconds:120,unmeasured:0}} disabled {...h}/>);
  expect((screen.getByRole('button',{name:'コピーして使う'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'このまま使う'}));expect(h.onKeepOnce).toHaveBeenCalledWith(['a']);
});
it('builds the same sentence for the batch of added videos',()=>{
  expect(slowMediaMessage(1,2**30,120)).toBe('この素材は読み込みに時間がかかる場所にあります（確認に約2分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。');
  expect(slowMediaMessage(3,3*2**30,59)).toBe('この素材（3本・合計 3.0 GB）は読み込みに時間がかかる場所にあります（確認に約1分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。');
});

// ---- Codex レビュー: 上限を超えた分は本数だけ伝える（コピーへ渡すのは並べた素材だけ） ----
it('says how many more there are beyond the listed ones',()=>{
  const h=handlers();render(<NativeSlowMediaAdvice advice={{targets:[target('a'),target('b')],totalBytes:2*2**30,totalSeconds:240,unmeasured:0,more:3}} disabled={false} {...h}/>);
  expect(screen.getByText(`ほかに 3 本あります（この${MAX_COPY_ITEMS}本の後に案内します）`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'コピーして使う'}));expect(h.onCopy).toHaveBeenCalledWith(['a','b']);
});
it('says nothing more when everything is listed',()=>{
  render(<NativeSlowMediaAdvice advice={{targets:[target('a')],totalBytes:2**30,totalSeconds:120,unmeasured:0,more:0}} disabled={false} {...handlers()}/>);
  expect(screen.queryByText(/ほかに/)).toBeNull();
});
