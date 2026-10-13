/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {COPY_ELSEWHERE_NOTE,COPY_WAITING_VOLUME_NOTE,type CopyJobView} from '../../shared/mediaCopy';
import {NativeCopyProgress,copySettledMessage} from './NativeCopyProgress';
afterEach(cleanup);
const MB=1e6;
const job=(patch:Partial<CopyJobView>):CopyJobView=>({jobId:'cp-00000000000000000000',projectId:'case',mode:'reconnect',state:'running',createdAt:'x',destination:{kind:'volume',label:'ssd'},
  items:[{itemId:'c0',name:'a.mp4',sizeBytes:100*MB,phase:'verifying',bytesDone:100*MB,assetId:'a'},{itemId:'c1',name:'b.mp4',sizeBytes:100*MB,phase:'waiting',bytesDone:0,assetId:'b'}],
  current:{index:0,bytesPerSecond:32*MB,remaining:{minSeconds:180,maxSeconds:360}},...patch});
const section=(heading:string)=>screen.getByText(heading).nextElementSibling?.textContent;

it('shows which file of how many, the stage, the speed, the remaining range and the drive warning; "残りを中止" says what stays',()=>{
  const onCancel=vi.fn();const view=render(<NativeCopyProgress jobs={[job({})]} onCancel={onCancel} onDismiss={vi.fn()}/>);
  expect(screen.getByText(/2 本中 1 本目/)).toBeTruthy();expect(screen.getByText('a.mp4: コピーを確認中')).toBeTruthy();
  expect(screen.getByText(/速さ 32 MB\/秒・残り 約 3〜6 分/)).toBeTruthy();expect(screen.getByText('コピーが終わるまで、元の媒体とコピー先のドライブを取り外さないでください')).toBeTruthy();
  expect(screen.getByText('完了した素材はコピー先につなぎ替えたまま残します')).toBeTruthy();
  expect(view.container.querySelector('[data-copy-job="cp-00000000000000000000"][data-state="running"] .native-copy-phase')).not.toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'残りを中止'}));expect(onCancel).toHaveBeenCalledWith('cp-00000000000000000000');
  expect((screen.getByRole('button',{name:'残りを中止'}) as HTMLButtonElement).disabled).toBe(true);   // 押した後は止まるまで押せない（二重に送らない）
});
it('after stopping, separates the reconnected, the unfinished and those still needing the original',()=>{
  const onDismiss=vi.fn();
  render(<NativeCopyProgress jobs={[job({state:'stopped',stopReason:'残りを中止しました',current:undefined,kept:['x.harness-part'],
    items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'cancelled',bytesDone:0,error:'残りを中止しました'}]})]} onCancel={vi.fn()} onDismiss={onDismiss}/>);
  expect(screen.getByText('コピーを止めました（1 / 2 本が完了）')).toBeTruthy();
  expect(section('接続を変えた素材（コピー先を使います）')).toBe('a.mp4');
  expect(section('未完了の素材')).toBe('b.mp4: 残りを中止しました');
  expect(section('まだ元の媒体が要る素材')).toBe('b.mp4');
  expect(screen.getByText(/消さずに残したファイル: x.harness-part/)).toBeTruthy();expect(screen.getByText(/消す前に中身を確かめてください/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'残りを中止'})).toBeNull();expect(screen.queryByText('コピーが終わるまで、元の媒体とコピー先のドライブを取り外さないでください')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'閉じる'}));expect(onDismiss).toHaveBeenCalledWith('cp-00000000000000000000');
});
// 申し送り（Task 13 のレビュー）: 接続の結果を確かめられなかった項目は「未完了」ではなく失敗として、理由の文をそのまま出す。
it('lists a failed item, including one whose connection could not be confirmed, as failed with its reason as is',()=>{
  render(<NativeCopyProgress jobs={[job({state:'stopped',stopReason:'コピーを止めました: 次の起動で台帳と照合します',current:undefined,
    items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'failed',bytesDone:0,error:'次の起動で台帳と照合します'},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'cancelled',bytesDone:0,error:'コピーを止めました: 次の起動で台帳と照合します'}]})]}
    onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(section('失敗した素材')).toBe('a.mp4: 次の起動で台帳と照合します');
  expect(section('未完了の素材')).toBe('b.mp4: コピーを止めました: 次の起動で台帳と照合します');
  expect(section('まだ元の媒体が要る素材')).toBe('a.mp4b.mp4');
});
it('says the copy finished with the count and that the copies are in use',()=>{
  render(<NativeCopyProgress jobs={[job({state:'finished',current:undefined,items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'done',bytesDone:1}]})]}
    onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText('コピーが終わりました（2 本）')).toBeTruthy();expect(section('接続を変えた素材（コピー先を使います）')).toBe('a.mp4b.mp4');
  expect(screen.queryByText('まだ元の媒体が要る素材')).toBeNull();expect(screen.getByRole('button',{name:'閉じる'})).toBeTruthy();
});
// 申し送り（Task 11 のレビュー）: このエディターが動かしていない作業は、進み具合のバーと「残りを中止」を出さず（中止は 404）、注記を出す。
it('shows a job run elsewhere without the progress bar or "残りを中止", with the note instead',()=>{
  const view=render(<NativeCopyProgress jobs={[job({notThisProcess:true,current:undefined})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText(COPY_ELSEWHERE_NOTE)).toBeTruthy();expect(screen.queryByRole('button',{name:'残りを中止'})).toBeNull();
  expect(view.container.querySelector('progress')).toBeNull();expect(screen.queryByRole('button',{name:'閉じる'})).toBeNull();
});
// 待ち中（コピー先のドライブの接続を待って回収する）の作業は段ではなく注記と分類。閉じられない（サーバは 409。記録は回収のため残す）ので、画面だけ隠せる。
it('shows a job waiting for its drive with the note and the groups, without stages or progress, and can hide it on this screen only',()=>{
  const onDismiss=vi.fn(),waiting=job({state:'waiting-volume',stopReason:'アプリの終了でコピーが止まりました',current:undefined,
    items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'copying',bytesDone:0}]});
  const view=render(<NativeCopyProgress jobs={[waiting]} onCancel={vi.fn()} onDismiss={onDismiss}/>);
  expect(screen.getByText(COPY_WAITING_VOLUME_NOTE)).toBeTruthy();expect(screen.getByText('アプリの終了でコピーが止まりました')).toBeTruthy();
  expect(section('接続を変えた素材（コピー先を使います）')).toBe('a.mp4');expect(section('未完了の素材')).toBe('b.mp4');expect(section('まだ元の媒体が要る素材')).toBe('b.mp4');
  expect(view.container.querySelector('progress')).toBeNull();expect(view.container.querySelector('.native-copy-phase')).toBeNull();
  expect(screen.queryByRole('button',{name:'閉じる'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'この表示を隠す'}));expect(view.container.querySelector('[data-copy-job]')).toBeNull();expect(onDismiss).not.toHaveBeenCalled();
  view.rerender(<NativeCopyProgress jobs={[{...waiting,state:'stopped'}]} onCancel={vi.fn()} onDismiss={onDismiss}/>);   // 回収が済んで状態が変われば、また出す
  expect(view.container.querySelector('[data-copy-job][data-state="stopped"]')).not.toBeNull();
});
it('shows nothing without jobs',()=>{
  const view=render(<NativeCopyProgress jobs={[]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);expect(view.container.innerHTML).toBe('');
});
it('lets "残りを中止" be pressed again when stopping failed',async()=>{
  render(<NativeCopyProgress jobs={[job({})]} onCancel={vi.fn(async()=>{throw new Error('コピーの作業が見つかりません');})} onDismiss={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'残りを中止'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'残りを中止'}) as HTMLButtonElement).disabled).toBe(false));
});
it('words the notice of a settled job by how it ended',()=>{
  const items:CopyJobView['items']=[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'cancelled',bytesDone:0}];
  expect(copySettledMessage(job({state:'finished',items:[items[0]!]}))).toBe('速いドライブへのコピーが終わりました（1 本）。素材はコピー先を使います');
  expect(copySettledMessage(job({state:'stopped',items}))).toBe('速いドライブへのコピーを止めました（1 / 2 本が完了）。素材の欄で内容を確かめてください');
  expect(copySettledMessage(job({state:'waiting-volume',items}))).toBe(`速いドライブへのコピーが止まりました（1 / 2 本が完了）。${COPY_WAITING_VOLUME_NOTE}`);
});
// 1本だけ失敗して残りを続けた作業はサーバで finished になる。全部移ったと思って元の媒体を外さないよう、失敗を見出しと通知に出す。
it('says a finished job had failures in the heading and the notice',()=>{
  const items:CopyJobView['items']=[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1},{itemId:'c1',name:'b.mp4',sizeBytes:1,phase:'failed',bytesDone:0,error:'元の素材の中身が登録時と一致しません'}];
  render(<NativeCopyProgress jobs={[job({state:'finished',current:undefined,items})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText('コピーが終わりました（1 / 2 本が完了・1 本は失敗）')).toBeTruthy();expect(section('失敗した素材')).toBe('b.mp4: 元の素材の中身が登録時と一致しません');
  expect(section('まだ元の媒体が要る素材')).toBe('b.mp4');
  expect(copySettledMessage(job({state:'finished',items}))).toBe('速いドライブへのコピーが終わりました（1 / 2 本が完了・1 本は失敗）。失敗した素材は元の媒体を使います');
});
it('says it is waiting for other checks of the same media before the first file starts, and measuring the speed once copying',()=>{
  const view=render(<NativeCopyProgress jobs={[job({current:undefined,items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'waiting',bytesDone:0}]})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText(/元の媒体のほかの確認が終わるのを待っています/)).toBeTruthy();expect(screen.queryByText(/速さを測っています/)).toBeNull();
  view.rerender(<NativeCopyProgress jobs={[job({current:{index:0},items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'copying',bytesDone:0}]})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText(/速さを測っています/)).toBeTruthy();
});
it('names the drive the copies went to (not a path), where kept files are',()=>{
  const stopped=(destination:CopyJobView['destination'])=>job({state:'stopped',current:undefined,destination,kept:['x.mp4'],items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'cancelled',bytesDone:0}]});
  const view=render(<NativeCopyProgress jobs={[stopped({kind:'volume',label:'ssd'})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText('コピー先: 「ssd」の「Harness 素材」フォルダー')).toBeTruthy();
  view.rerender(<NativeCopyProgress jobs={[stopped({kind:'custom',label:'指定した場所（mine）'})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText('コピー先: 指定した場所（mine）')).toBeTruthy();
});
// 進み具合の GB はダイアログと同じ丸め（コピーした量は切り捨て、コピーする量は切り上げ）。
it('rounds the copied amount down and the amount to copy up',()=>{
  const GiB=2**30;
  render(<NativeCopyProgress jobs={[job({items:[{itemId:'c0',name:'a.mp4',sizeBytes:1.04*GiB,phase:'copying',bytesDone:0.99*GiB}],current:{index:0}})]} onCancel={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.getByText(/^0\.9 \/ 1\.1 GB/)).toBeTruthy();
});
it('closes a job once: "閉じる" stays off after pressing, and comes back when closing failed',async()=>{
  let fail!:(error:Error)=>void;const onDismiss=vi.fn(()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
  render(<NativeCopyProgress jobs={[job({state:'finished',current:undefined,items:[{itemId:'c0',name:'a.mp4',sizeBytes:1,phase:'done',bytesDone:1}]})]} onCancel={vi.fn()} onDismiss={onDismiss}/>);
  fireEvent.click(screen.getByRole('button',{name:'閉じる'}));expect((screen.getByRole('button',{name:'閉じる'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'閉じる'}));expect(onDismiss).toHaveBeenCalledTimes(1);
  fail(new Error('閉じられません'));await waitFor(()=>expect((screen.getByRole('button',{name:'閉じる'}) as HTMLButtonElement).disabled).toBe(false));
});
