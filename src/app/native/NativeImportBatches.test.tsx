/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeImportBatches} from './NativeImportBatches';
import type {ImportBatchView} from '../../shared/importBatches';
afterEach(cleanup);
const batch=(phase:ImportBatchView['phase'],items:ImportBatchView['items']):ImportBatchView=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'p',createdAt:'x',origin:{kind:'ui'},placement:'append-main',mode:'link',phase,items});
it('offers placing a ready batch and cancelling it',()=>{
  const onConfirm=vi.fn(),onCancel=vi.fn();
  const view=render(<NativeImportBatches batches={[batch('ready',[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready'}])]} disabled={false} onConfirm={onConfirm} onCancel={onCancel}/>);
  expect(view.getByText('準備済み・未配置（1本）')).toBeTruthy();
  fireEvent.click(view.getByRole('button',{name:'メインの末尾に並べる'}));expect(onConfirm).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa',false);
  fireEvent.click(view.getByRole('button',{name:'束を取り消す'}));expect(onCancel).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa');
});
it('lists the failures and offers placing the rest',()=>{
  const onConfirm=vi.fn();
  const view=render(<NativeImportBatches batches={[batch('partial',[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready'},{itemId:'i1',key:'1',name:'b.mp4',phase:'failed',error:'壊れています'}])]} disabled={false} onConfirm={onConfirm} onCancel={vi.fn()}/>);
  expect(view.getByText('b.mp4: 壊れています')).toBeTruthy();
  fireEvent.click(view.getByRole('button',{name:'失敗分を除いて並べる'}));expect(onConfirm).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa',true);
});
it('tells which confirmed imports are not in the edit and how to add them again, without offering to place them',()=>{
  const view=render(<NativeImportBatches batches={[]} unplaced={[{...batch('confirmed',[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',assetId:'x'},{itemId:'i1',key:'1',name:'b.mp4',phase:'failed',error:'壊れています'}]),confirmed:{executionId:'e',revision:4}}]} disabled={false} onConfirm={vi.fn()} onCancel={vi.fn()}/>);
  expect(view.getByText(/配置の記録がある取り込み（1本）が、今の編集内容に並んでいません/)).toBeTruthy();
  expect(view.getByText('a.mp4')).toBeTruthy();expect(view.queryByText('b.mp4')).toBeNull();expect(view.queryAllByRole('button')).toHaveLength(0);
});
it('explains a batch stuck in placing and offers no buttons (the server refuses to cancel it)',()=>{
  const view=render(<NativeImportBatches batches={[batch('confirming',[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready'},{itemId:'i1',key:'1',name:'b.mp4',phase:'ready'}])]} disabled={false} onConfirm={vi.fn()} onCancel={vi.fn()}/>);
  expect(view.getByText(/配置が止まっています（2本）/)).toBeTruthy();expect(view.queryAllByRole('button')).toHaveLength(0);
});

// ---- 追加時の判断待ち（設計 §2）: 束の全項目の判定後に1回だけ案内。文言は 2026-10-06 決定 ----
const awaiting=(itemId:string,name:string,canRemember?:false):ImportBatchView['items'][number]=>({itemId,key:itemId,name,phase:'awaiting-decision',slow:{sizeBytes:2**30,seconds:120,...(canRemember===false?{canRemember}:{})}});
const keepAlways=(container:HTMLElement)=>container.querySelector<HTMLInputElement>('input[type=checkbox]');
it('asks once whether to copy the slow items of a batch, with the estimate, and says the 64MB was read to decide',()=>{
  const onDecide=vi.fn(),onCopyBatch=vi.fn();
  const view=render(<NativeImportBatches batches={[{...batch('deciding',[awaiting('i0','a.mp4'),{itemId:'i1',key:'1',name:'b.mp4',phase:'ready'}]),
    decision:{itemIds:['i0'],totalBytes:2**30,totalSeconds:120}}]} disabled={false} onConfirm={vi.fn()} onCancel={vi.fn()} onDecide={onDecide} onCopyBatch={onCopyBatch}/>);
  expect(view.getByText('この素材は読み込みに時間がかかる場所にあります（確認に約2分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。')).toBeTruthy();
  expect(view.getByText(/先頭 64MB を試しに読みました/)).toBeTruthy();expect(view.container.querySelectorAll('[data-import-decision]')).toHaveLength(1);
  fireEvent.click(view.getByRole('button',{name:'コピーして使う'}));expect(onCopyBatch).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa');
  fireEvent.click(view.getByRole('button',{name:'このまま使う'}));expect(onDecide).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa','keep-once');
  expect(view.getByText('準備済み 1本・判断待ち 1本')).toBeTruthy();
});
it('gives the count and the total for several items, and decides keep-always when "今後この場所では出さない" is chosen on the spot',()=>{
  const onDecide=vi.fn();
  const view=render(<NativeImportBatches batches={[{...batch('deciding',[awaiting('i0','a.mp4'),awaiting('i1','b.mp4')]),decision:{itemIds:['i0','i1'],totalBytes:2**31,totalSeconds:240}}]}
    disabled={false} onConfirm={vi.fn()} onCancel={vi.fn()} onDecide={onDecide} onCopyBatch={vi.fn()}/>);
  expect(view.getByText('この素材（2本・合計 2.0 GB）は読み込みに時間がかかる場所にあります（確認に約4分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。')).toBeTruthy();
  expect(view.getAllByRole('button').map(button=>button.textContent)).toEqual(['コピーして使う','このまま使う','束を取り消す']);
  expect(view.getByText('a.mp4（約2分）')).toBeTruthy();expect(view.getByText('b.mp4（約2分）')).toBeTruthy();   // 開いた時の案内と同じ一覧の書き方
  fireEvent.click(view.getByRole('checkbox',{name:'今後この場所では出さない'}));fireEvent.click(view.getByRole('button',{name:'このまま使う'}));
  expect(onDecide).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa','keep-always');
});
it('lets a batch waiting for a decision be cancelled, and counts the items still being prepared and the failed ones',()=>{
  const onCancel=vi.fn();
  const view=render(<NativeImportBatches batches={[{...batch('preparing',[awaiting('i0','a.mp4'),{itemId:'i1',key:'1',name:'b.mp4',phase:'probing'},
    {itemId:'i2',key:'2',name:'c.mp4',phase:'failed',error:'壊れています'}]),decision:{itemIds:['i0'],totalBytes:2**30,totalSeconds:120}}]} disabled={false} onConfirm={vi.fn()} onCancel={onCancel} onDecide={vi.fn()} onCopyBatch={vi.fn()}/>);
  expect(view.getByText('準備済み 0本・準備中 1本・判断待ち 1本・準備できなかった 1本')).toBeTruthy();expect(view.getByText('c.mp4: 壊れています')).toBeTruthy();
  fireEvent.click(view.getByRole('button',{name:'束を取り消す'}));expect(onCancel).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa');
});
// 申し送り（Task 13）: 判断待ちの項目がすべてドライブを識別できない（canRemember:false）なら「今後出さない」を出さない。混じる時は出す（サーバが今回だけとして扱う）。
it('does not offer "今後この場所では出さない" when no drive of the waiting items can be told apart, and says so when only some can',()=>{
  const props={disabled:false,onConfirm:vi.fn(),onCancel:vi.fn(),onDecide:vi.fn(),onCopyBatch:vi.fn()};
  const view=render(<NativeImportBatches batches={[{...batch('deciding',[awaiting('i0','a.mp4',false),awaiting('i1','b.mp4',false)]),decision:{itemIds:['i0','i1'],totalBytes:2**31,totalSeconds:240}}]} {...props}/>);
  expect(keepAlways(view.container)).toBeNull();fireEvent.click(view.getByRole('button',{name:'このまま使う'}));expect(props.onDecide).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa','keep-once');
  view.rerender(<NativeImportBatches batches={[{...batch('deciding',[awaiting('i0','a.mp4',false),awaiting('i1','b.mp4')]),batchId:'imp-bbbbbbbbbbbbbbbbbbbb',decision:{itemIds:['i0','i1'],totalBytes:2**31,totalSeconds:240}}]} {...props}/>);
  expect(view.queryByText(/ドライブを識別できない/)).toBeNull();fireEvent.click(view.getByRole('checkbox',{name:'今後この場所では出さない'}));
  expect(view.getByText('ドライブを識別できない素材（a.mp4）は、今回だけこのまま使います。')).toBeTruthy();
});
// 申し送り（Task 13 のレビュー）: 残りを中止・コピーを始められなかった・接続の結果を確かめられなかった時、同じ束に判断の案内が再び付く。
it('takes a choice once, and asks again when the same batch waits for a decision again (and says the last copy did not finish)',async()=>{
  let settle!:(ok:boolean)=>void;const onDecide=vi.fn(()=>new Promise<void>((resolve,reject)=>{settle=ok=>ok?resolve():reject(new Error('x'));}));
  const deciding={...batch('deciding',[awaiting('i0','a.mp4')]),decision:{itemIds:['i0'],totalBytes:2**30,totalSeconds:120}};
  const props={disabled:false,onConfirm:vi.fn(),onCancel:vi.fn(),onDecide,onCopyBatch:vi.fn()};
  const view=render(<NativeImportBatches batches={[deciding]} {...props}/>),button=(name:string)=>view.getByRole('button',{name}) as HTMLButtonElement;
  fireEvent.click(button('このまま使う'));expect(button('このまま使う').disabled).toBe(true);expect(button('コピーして使う').disabled).toBe(true);expect(keepAlways(view.container)!.disabled).toBe(true);
  fireEvent.click(button('このまま使う'));expect(onDecide).toHaveBeenCalledTimes(1);
  await act(async()=>{settle(false);});await waitFor(()=>expect(button('このまま使う').disabled).toBe(false));   // 失敗したらもう一度選べる
  fireEvent.click(button('このまま使う'));await act(async()=>{settle(true);});expect(button('このまま使う').disabled).toBe(true);   // 決まった後は一覧の更新を待つ
  view.rerender(<NativeImportBatches batches={[{...deciding,phase:'preparing',items:[{...deciding.items[0]!,phase:'waiting',choice:'keep-once'}],decision:undefined}]} {...props}/>);
  expect(view.container.querySelector('[data-import-decision]')).toBeNull();
  view.rerender(<NativeImportBatches batches={[deciding]} {...props} unfinishedCopies={new Set(['imp-aaaaaaaaaaaaaaaaaaaa:i0'])}/>);
  expect(button('このまま使う').disabled).toBe(false);expect(view.getByText(/前回のコピーを最後まで終えられなかった動画があります/)).toBeTruthy();
});
