/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NativeTelopAdd} from './NativeTelopAdd';
import type {SequenceAsset} from '../../core/sequence/model';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

const asset:SequenceAsset={id:'component-abc',kind:'component',name:'追加パック test-pack',file:'.harness/components/abc.mjs',fingerprint:'a'.repeat(64),streams:[]};
const inspected={packId:'test-pack',version:'abcd1234',kind:'pack',ids:[1,2],names:['白ふち','黒帯'],conflicts:[]};

/** 呼ばれた URL を順に記録しつつ、パスごとの応答を返す。 */
function stubFetch(handler:(url:string)=>{ok:boolean;json():Promise<unknown>}) {
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);return handler(url);}));
  return calls;
}
const paths=(calls:string[]):string[]=>calls.map(url=>url.split('?')[0]!);

async function pickFolder() {
  fireEvent.click(screen.getByRole('button',{name:'テロップを追加'}));
  await screen.findByRole('dialog');
  await waitFor(()=>expect((screen.getByRole('button',{name:'このフォルダを選ぶ'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'このフォルダを選ぶ'}));
}

// フォルダピッカーは browseFolder() を叩く。テストでは常に固定の1フォルダを返し、
// 「このフォルダを選ぶ」を押したらすぐ下見が動く経路だけを検証する。
vi.mock('../browseApi',()=>({browseFolder:vi.fn(async()=>({roots:[],path:'/tmp/pack',parent:null,dirs:[],files:[],truncated:false}))}));

// I-1: `.native-inspector-host` は container-type:inline-size を持つので、その子孫に置いた
// position:fixed のオーバーレイはその箱に閉じ込められて overflow:auto に切られる。ポータル先は
// `.native-workspace`（fieldset の無効化・下書き確定の捕捉ハンドラ・操作音の内側）。
it('フォルダ選択の全画面オーバーレイをインスペクタの外（ワークスペース）へ出す',async()=>{
  stubFetch(()=>({ok:true,json:async()=>inspected}));
  render(<main className="native-workspace"><div className="native-inspector-host"><div className="native-inspector">
    <NativeTelopAdd projectId="proj" disabled={false} onRegister={vi.fn(async()=>true)}/>
  </div></div></main>);
  fireEvent.click(screen.getByRole('button',{name:'テロップを追加'}));
  const overlay=(await screen.findByRole('dialog')).closest('.native-style-overlay');
  expect(overlay).toBeTruthy();                                            // 存在検査（消えていれば「外に出た」と区別できない）
  expect(overlay!.closest('.native-inspector-host')).toBeNull();
  expect(overlay!.closest('.native-workspace')).toBe(window.document.querySelector('.native-workspace'));
});

it('下見だけで確認画面を出し、この時点では取り込みを呼ばない',async()=>{
  const calls=stubFetch(()=>({ok:true,json:async()=>inspected}));
  const onRegister=vi.fn(async()=>true);
  render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={onRegister}/>);
  await pickFolder();
  const dialog=await screen.findByRole('alertdialog',{name:'取り込み内容の確認'});
  expect(dialog.textContent).toContain('test-pack');
  expect(dialog.textContent).toContain('2件');
  expect(dialog.textContent).toContain('1、2');
  expect(paths(calls)).toEqual(['/api/telop-add/inspect']);
  expect(onRegister).not.toHaveBeenCalled();
});

it('「一覧に加える」を押したときだけ /api/telop-add を叩いて登録する',async()=>{
  const calls=stubFetch(url=>url.includes('/inspect')
    ? {ok:true,json:async()=>inspected}
    : {ok:true,json:async()=>({packId:'test-pack',version:'abcd1234',kind:'pack',added:[1,2],conflicts:[],asset})});
  const onRegister=vi.fn(async()=>true);
  render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={onRegister}/>);
  await pickFolder();
  const dialog=await screen.findByRole('alertdialog',{name:'取り込み内容の確認'});
  fireEvent.click(within(dialog).getByRole('button',{name:'一覧に加える'}));
  await waitFor(()=>expect(onRegister).toHaveBeenCalledWith(asset));
  expect(paths(calls)).toEqual(['/api/telop-add/inspect','/api/telop-add']);
});

it('「やめる」は取り込みを一度も呼ばない（残骸が出ない）',async()=>{
  const calls=stubFetch(()=>({ok:true,json:async()=>inspected}));
  const onRegister=vi.fn(async()=>true);
  render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={onRegister}/>);
  await pickFolder();
  const dialog=await screen.findByRole('alertdialog',{name:'取り込み内容の確認'});
  fireEvent.click(within(dialog).getByRole('button',{name:'やめる'}));
  await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(paths(calls)).toEqual(['/api/telop-add/inspect']);
  expect(onRegister).not.toHaveBeenCalled();
});

it('番号が衝突しているときは中止だけを出す（追加ボタンを出さない）',async()=>{
  const calls=stubFetch(()=>({ok:true,json:async()=>({...inspected,conflicts:[2]})}));
  const onRegister=vi.fn(async()=>true);
  render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={onRegister}/>);
  await pickFolder();
  const dialog=await screen.findByRole('alertdialog',{name:'取り込み内容の確認'});
  expect(dialog.textContent).toContain('既にあります');
  expect(within(dialog).queryByRole('button',{name:'一覧に加える'})).toBeNull();
  fireEvent.click(within(dialog).getByRole('button',{name:'閉じる'}));
  await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(paths(calls)).toEqual(['/api/telop-add/inspect']);
  expect(onRegister).not.toHaveBeenCalled();
});

it('下見が断ったときは本文をそのまま出す',async()=>{
  stubFetch(()=>({ok:false,json:async()=>({error:'zip を展開したフォルダを選んでください。'})}));
  const onRegister=vi.fn(async()=>true);
  render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={onRegister}/>);
  await pickFolder();
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toBe('zip を展開したフォルダを選んでください。');
  expect(onRegister).not.toHaveBeenCalled();
});

// M-1': ダイアログはポータルで <fieldset disabled> の外へ出るので、無効化は明示で渡す（I-3 と同型の穴）。
it('AI 作業中（disabled）はダイアログのボタンも押せない',async()=>{
  stubFetch(()=>({ok:true,json:async()=>inspected}));
  const {rerender}=render(<NativeTelopAdd projectId="proj" disabled={false} onRegister={vi.fn(async()=>true)}/>);
  fireEvent.click(screen.getByRole('button',{name:'テロップを追加'}));
  const dialog=await screen.findByRole('dialog');
  await waitFor(()=>expect((within(dialog).getByRole('button',{name:'このフォルダを選ぶ'}) as HTMLButtonElement).disabled).toBe(false));
  rerender(<NativeTelopAdd projectId="proj" disabled onRegister={vi.fn(async()=>true)}/>);
  expect((within(dialog).getByRole('button',{name:'このフォルダを選ぶ'}) as HTMLButtonElement).disabled).toBe(true);
  // I-2: 閉じる導線は副作用がないので disabled に関係なく常に押せる（AI 作業中でもダイアログを閉じられる）。
  expect((within(dialog).getByRole('button',{name:'フォルダ選択を閉じる'}) as HTMLButtonElement).disabled).toBe(false);
});
