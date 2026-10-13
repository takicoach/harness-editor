/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {COPY_GB_NOTE,COPY_REMOVABLE_NOTE,type CopyDestinationView} from '../../shared/mediaCopy';
import {NativeCopyDestinationDialog} from './NativeCopyDestinationDialog';
import {NativeApiError} from './api';
vi.mock('../panels/MediaPicker',()=>({MediaPicker:(p:{onPickFolder?:(path:string)=>void;onCancel():void})=><section aria-label="folder picker"><button onClick={()=>p.onPickFolder?.('/Volumes/SSD/mine')}>pick mine</button></section>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const GiB=2**30;
const view=(patch:Partial<CopyDestinationView>):CopyDestinationView=>({key:'internal',label:'このMac（ムービー）',volume:{uuid:'BOOT',dev:1},
  space:{free:300*GiB,capacity:500*GiB,after:270*GiB,margin:50*GiB},selectable:true,time:{minSeconds:960,maxSeconds:2700},...patch});
type Answer={ok:boolean;json():Promise<unknown>};
function stub(lists:Array<CopyDestinationView[]|Answer>){
  const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>{const next=lists.shift()??[];return Array.isArray(next)?{ok:true,json:async()=>({destinations:next,totalBytes:29*GiB})}:next;});
  vi.stubGlobal('fetch',fetch);return fetch;
}

it('shows free space, the space after the copy, the time range, and why a drive cannot be chosen; recommends one',async()=>{
  stub([[view({recommended:true}),view({key:'volume:SMALL',label:'small',volume:{uuid:'SMALL',dev:3},space:{free:21*GiB,capacity:32*GiB,after:-8*GiB,margin:20*GiB},time:null,selectable:false,
    reason:'コピー後の空きが 0.0 GB になり、安全のための余裕（20.0 GB＝20GB か容量の10%の大きい方）を下回ります'})]]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  expect(await screen.findByText(/空き 300.0 GB／容量 500.0 GB → コピー後 270.0 GB/)).toBeTruthy();expect(screen.getByText(/約 16〜45 分/)).toBeTruthy();
  expect((screen.getByRole('radio',{name:'small'}) as HTMLInputElement).disabled).toBe(true);expect(screen.getByText(/安全のための余裕/)).toBeTruthy();
  expect((screen.getByRole('radio',{name:'このMac（ムービー）'}) as HTMLInputElement).checked).toBe(true);expect(screen.getByText('おすすめ')).toBeTruthy();
  expect(screen.getByText('コピーが終わるまで、元の媒体とコピー先のドライブを取り外さないでください')).toBeTruthy();
  expect(screen.getByRole('dialog',{name:'コピー先を選ぶ'})).toBeTruthy();
});
it('applies the same checks to a chosen folder and starts with the identity seen when choosing',async()=>{
  const fetch=stub([[view({recommended:true})],[view({}),view({key:'custom',label:'指定した場所（mine）',volume:{uuid:'SSD',dev:7}})]]);
  const onStart=vi.fn(async()=>undefined);render(<NativeCopyDestinationDialog projectId="case" targets={{batchId:'imp-aaaaaaaaaaaaaaaaaaaa'}} onStart={onStart} onCancel={vi.fn()}/>);
  await screen.findByText('おすすめ');fireEvent.click(screen.getByRole('button',{name:'場所を指定…'}));fireEvent.click(await screen.findByText('pick mine'));
  await waitFor(()=>expect((screen.getByRole('radio',{name:'指定した場所（mine）'}) as HTMLInputElement).checked).toBe(true));
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',customPath:'/Volumes/SSD/mine'});
  fireEvent.click(screen.getByRole('button',{name:'コピーを始める'}));
  await waitFor(()=>expect(onStart).toHaveBeenCalledWith({key:'custom',uuid:'SSD',dev:7,customPath:'/Volumes/SSD/mine'}));
});
// 申し送り（Task 5）: 空きを測る前に断った候補（space:null）は「空き … → コピー後 …」を出さず理由だけ。0.0 GB と誤って見せない。
it('shows only the reason for a place refused before measuring its space',async()=>{
  stub([[view({recommended:true}),view({key:'custom',label:'指定した場所（net）',volume:{uuid:'',dev:-1},space:null,time:{minSeconds:960,maxSeconds:2700},selectable:false,reason:'ネットワークの場所には置けません'})]]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  const option=(await screen.findByRole('radio',{name:'指定した場所（net）'})).closest('label')!;
  expect(option.textContent).toContain('ネットワークの場所には置けません');expect(option.textContent).not.toMatch(/空き|コピー後|所要時間/);
  expect(option.textContent).not.toContain('GB');
});
// 申し送り（Task 3 のレビュー）: GB は 1024³ 単位の注記。空き・コピー後は 0.1GB 単位の切り捨て（space.ts の理由の文と同じ丸め）、コピーする量は切り上げ。
it('rounds free space and the space after the copy down, the amount to copy up, and notes the 1024³ unit',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({totalBytes:29*GiB+1,destinations:[view({recommended:true,space:{free:300*GiB-1,capacity:500*GiB,after:20.06*GiB,margin:20*GiB}})]})})));
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  expect(await screen.findByText(/空き 299.9 GB／容量 500.0 GB → コピー後 20.0 GB/)).toBeTruthy();
  expect(screen.getByText(/コピーする量: 29.1 GB/)).toBeTruthy();expect(screen.getByText(COPY_GB_NOTE)).toBeTruthy();
});
it('says when no place can be chosen and keeps the start button off',async()=>{
  stub([[view({selectable:false,reason:'コピー後の空きが 1.0 GB になり、安全のための余裕（20.0 GB＝20GB か容量の10%の大きい方）を下回ります'})]]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  expect(await screen.findByText(/選べるコピー先がありません/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'コピーを始める'}) as HTMLButtonElement).disabled).toBe(true);
});
// 開始の 409（入れ替わり・別のエディターが後片付け中など）は理由をそのまま出し、候補を調べ直す（選び直せるように）。
it('shows why the copy could not start and looks at the places again',async()=>{
  const fetch=stub([[view({recommended:true})],[view({recommended:true,space:{free:200*GiB,capacity:500*GiB,after:170*GiB,margin:50*GiB}})]]);
  const onStart=vi.fn(async()=>{throw new NativeApiError('コピー先のドライブが選んだ時から入れ替わりました。もう一度選んでください',409);});
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={onStart} onCancel={vi.fn()}/>);
  await screen.findByText('おすすめ');fireEvent.click(screen.getByRole('button',{name:'コピーを始める'}));
  expect(await screen.findByText('コピー先のドライブが選んだ時から入れ替わりました。もう一度選んでください')).toBeTruthy();
  expect(await screen.findByText(/空き 200.0 GB/)).toBeTruthy();expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText('コピー先のドライブが選んだ時から入れ替わりました。もう一度選んでください')).toBeTruthy();   // 調べ直しても理由は消さない
});
it('shows the server reason when the places cannot be listed',async()=>{
  stub([{ok:false,json:async()=>({error:'コピー先を調べられません（EIO）'})}]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  expect(await screen.findByText('コピー先を調べられません（EIO）')).toBeTruthy();
});
// 通信の失敗など、サーバの決まった文言ではない失敗（英文を含みうる）はそのまま出さない。
it('does not show a failure that is not one of the server reasons as is',async()=>{
  stub([[view({recommended:true})],[view({recommended:true})]]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn(async()=>{throw new TypeError('Failed to fetch');})} onCancel={vi.fn()}/>);
  await screen.findByText('おすすめ');fireEvent.click(screen.getByRole('button',{name:'コピーを始める'}));
  expect(await screen.findByText('コピーを始められませんでした。')).toBeTruthy();expect(screen.queryByText(/Failed/)).toBeNull();
});
// 始めている間（開始の確認中）は閉じない（閉じても作業は始まりうるため、結果を見せるまで待つ）。
it('cannot be closed while starting',async()=>{
  stub([[view({recommended:true})]]);const onCancel=vi.fn();
  const view_=render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn(()=>new Promise<void>(()=>undefined))} onCancel={onCancel}/>);
  await screen.findByText('おすすめ');fireEvent.click(screen.getByRole('button',{name:'コピーを始める'}));
  expect(await screen.findByRole('button',{name:'始めています…'})).toBeTruthy();
  expect((screen.getByRole('button',{name:'キャンセル'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view_.container.querySelector('.export-overlay')!);expect(onCancel).not.toHaveBeenCalled();
});
it('shows the note on a removable card row only',async()=>{
  stub([[view({recommended:true}),view({key:'volume:SD',label:'SDCARD',volume:{uuid:'SD',dev:4},note:COPY_REMOVABLE_NOTE})]]);
  render(<NativeCopyDestinationDialog projectId="case" targets={{assetIds:['a']}} onStart={vi.fn()} onCancel={vi.fn()}/>);
  const note=await screen.findByText('SD カードは書き込みが遅いことがあります');
  expect(note.closest('[data-destination]')?.getAttribute('data-destination')).toBe('volume:SD');
  expect(screen.getAllByText('SD カードは書き込みが遅いことがあります')).toHaveLength(1);
  expect((screen.getByRole('radio',{name:'このMac（ムービー）'}) as HTMLInputElement).checked).toBe(true);
});
