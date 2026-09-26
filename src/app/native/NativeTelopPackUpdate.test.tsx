/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeTelopPackUpdate} from './NativeTelopPackUpdate';

const plan={assetId:'old-1',fromVersion:'1.0.0',toVersion:'1.1.0',captionCount:42,gainingCount:7,losingClipIds:['c3']};
const asset={id:'new-1',kind:'component',name:'テロップスタイル'};

/** telop クリップ 1 件だけを持つ最小の document（このコンポーネントは表示に使わないが型を満たす）。 */
function makeDocument(assetId:string,data:Record<string,unknown>={}){
  return {schemaVersion:2,id:'d1',name:'t',revision:7,fps:{num:30,den:1},resolution:{width:1,height:1},
    sequenceEndFrame:1,background:'#000',assets:[],tracks:[],transitions:[],transcripts:[],
    clips:[{id:'c1',content:{kind:'telop',componentAssetId:assetId,data:{text:'あ',template:1,...data}}}]} as never;
}

/** URL の一部で応答を選ぶ fetch のモック。呼ばれた URL の順序も見られるように spy を返す。 */
function stubFetch(map:Record<string,{ok?:boolean;body:unknown}>){
  return vi.fn(async(url:string)=>{
    const key=Object.keys(map).find(path=>String(url).includes(path));
    const hit=key?map[key]!:{ok:false,body:{error:'unknown'}};
    return {ok:hit.ok!==false,status:hit.ok===false?500:200,json:async()=>hit.body} as Response;
  });
}
const props=(over={})=>({projectId:'p1',document:makeDocument('old-1'),disabled:false,
  onRegisterAsset:vi.fn(async()=>true),onReplaceAsset:vi.fn(async()=>true),...over});

afterEach(cleanup);
beforeEach(()=>{vi.restoreAllMocks();});

it('最初の描画では fetch を 1 本も出さない',async()=>{
  const fetchSpy=stubFetch({});vi.stubGlobal('fetch',fetchSpy);
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  expect(view.getByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('確認すると版と対象件数・新しく動き始める件数を出す',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  const group=await view.findByRole('group',{name:'テロップスタイルの更新内容'});
  expect(group.textContent).toContain('1.0.0');
  expect(group.textContent).toContain('1.1.0');
  expect(group.textContent).toContain('42件');
  expect(group.textContent).toContain('7件');
  // 選べなくなる動きの件数も出す（losingClipIds は件数で伝える）。
  expect(group.textContent).toContain('1件の字幕は');
  expect(view.getByRole('button',{name:'42件を更新する'})).toBeTruthy();
});

it('更新は register → replace の順で 2 コマンド',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}},'/apply':{body:{asset}}}));
  const order:string[]=[];
  const onRegisterAsset=vi.fn(async(_asset:{id:string})=>{order.push('register');return true;});
  const onReplaceAsset=vi.fn(async(_from:string,_to:string)=>{order.push('replace');return true;});
  const view=render(<NativeTelopPackUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  fireEvent.click(await view.findByRole('button',{name:'42件を更新する'}));
  await waitFor(()=>expect(order).toEqual(['register','replace']));
  expect(onRegisterAsset.mock.calls[0]![0]).toMatchObject({id:'new-1'});
  expect(onReplaceAsset.mock.calls[0]).toEqual(['old-1','new-1']);
  expect((await view.findByRole('status')).textContent).toContain('1.1.0 に更新しました');
});

it('register が失敗したら replace へ進まない',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}},'/apply':{body:{asset}}}));
  const onRegisterAsset=vi.fn(async()=>false),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopPackUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  fireEvent.click(await view.findByRole('button',{name:'42件を更新する'}));
  await waitFor(()=>expect(onRegisterAsset).toHaveBeenCalled());
  expect(onReplaceAsset).not.toHaveBeenCalled();
  expect((await view.findByRole('status')).textContent).toContain('登録できませんでした');
});

it('最新なら「このテロップスタイルは最新です。」を出し、更新ボタンを出さない',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan:null}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  expect((await view.findByRole('status')).textContent).toBe('このテロップスタイルは最新です。');
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
  expect(view.queryByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeNull();
});

it('更新に成功したら確認ボタンが戻る（Undo で旧版に戻したあと再確認できる。Codex P2-2）',async()=>{
  // 旧実装は成功後 `plan=null` にしていたため、確認ボタンも計画も消えたまま戻せなかった。
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}},'/apply':{body:{asset}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  fireEvent.click(await view.findByRole('button',{name:'42件を更新する'}));
  await waitFor(()=>expect(view.getByRole('status').textContent).toContain('1.1.0 に更新しました'));
  // 成功通知は残したまま、確認ボタンだけが戻る。
  expect(view.getByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeTruthy();
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
});

it('文書の参照先が変わったら計画を捨てる（古い件数のまま押させない。Codex P2-2）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  expect(await view.findByRole('group',{name:'テロップスタイルの更新内容'})).toBeTruthy();
  // 参照先が old-1 → new-1 に動いた文書で描き直す（Undo / 別操作での参照切替に相当）。
  view.rerender(<NativeTelopPackUpdate {...props({document:makeDocument('new-1')})}/>);
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
  expect(view.getByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeTruthy();
});

it('参照先が同じなら再描画で計画は消えない（無関係な再描画で畳まない）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  expect(await view.findByRole('group',{name:'テロップスタイルの更新内容'})).toBeTruthy();
  view.rerender(<NativeTelopPackUpdate {...props({document:makeDocument('old-1')})}/>);
  expect(view.getByRole('group',{name:'テロップスタイルの更新内容'})).toBeTruthy();
});

it('切替の起点が無い計画では何も登録せず「更新しました」を出さない（レビュー I-1）',async()=>{
  // 起点が無い案件（同梱スタイル未使用）では plan は null になるが、画面は HTTP 越しの値を受けるので
  // 境界でも弾く。旧実装は register だけ打って文書を dirty にし、成功を名乗っていた。
  const noStart={...plan,assetId:null};
  const fetchSpy=stubFetch({'/plan':{body:{plan:noStart}},'/apply':{body:{asset}}});
  vi.stubGlobal('fetch',fetchSpy);
  const onRegisterAsset=vi.fn(async()=>true),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopPackUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  fireEvent.click(await view.findByRole('button',{name:'42件を更新する'}));
  await waitFor(()=>expect(view.getByRole('status').textContent).toContain('更新するものがありません'));
  expect(onRegisterAsset).not.toHaveBeenCalled();
  expect(onReplaceAsset).not.toHaveBeenCalled();
  expect(view.getByRole('status').textContent).not.toContain('更新しました');
  expect(fetchSpy.mock.calls.every(call=>!String(call[0]).includes('/apply'))).toBe(true);
});

it('確認後に字幕の動きを変えたら計画を捨てる（古い件数のまま押させない。Codex 2 巡目 #5）',async()=>{
  // 参照先 assetId は動いていない。`gainingCount` / `losingClipIds` は字幕ごとの animation から
  // 数えているので、参照先の集合だけを鍵にしていると古い件数のまま「更新する」が押せた。
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  expect(await view.findByRole('group',{name:'テロップスタイルの更新内容'})).toBeTruthy();
  view.rerender(<NativeTelopPackUpdate {...props({document:makeDocument('old-1',{animation:'charByChar'})})}/>);
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
  expect(view.getByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeTruthy();
});

it('確認後に字幕のスタイル（template）を変えたら計画を捨てる（Codex 2 巡目 #5）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  expect(await view.findByRole('group',{name:'テロップスタイルの更新内容'})).toBeTruthy();
  view.rerender(<NativeTelopPackUpdate {...props({document:makeDocument('old-1',{template:9})})}/>);
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
});

it('応答が返る前に文書が変わったら、その応答は捨てる（古い計画が復活しない。最終レビュー N-2）',async()=>{
  // 参照先そのものを動かすので、計画は一度畳まれる。**遅れて届いた応答で復活してはいけない。**
  let release=():void=>{};
  const gate=new Promise<void>(resolve=>{release=()=>resolve();});
  vi.stubGlobal('fetch',vi.fn(async()=>{
    await gate;
    return {ok:true,status:200,json:async()=>({plan})} as Response;
  }));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  view.rerender(<NativeTelopPackUpdate {...props({document:makeDocument('new-1')})}/>);
  await act(async()=>{release();await new Promise(resolve=>setTimeout(resolve,0));});
  expect(view.queryByRole('group',{name:'テロップスタイルの更新内容'})).toBeNull();
  expect(view.getByRole('button',{name:'テロップスタイルの更新を確認する'})).toBeTruthy();
});

it('対象の字幕が無いときは「最新です」と言わない（Codex 2 巡目 #4）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{body:{plan:null,reason:'no-captions'}}}));
  const view=render(<NativeTelopPackUpdate {...props()}/>);
  fireEvent.click(view.getByRole('button',{name:'テロップスタイルの更新を確認する'}));
  const status=await view.findByRole('status');
  expect(status.textContent).toContain('更新する対象がありません');
  expect(status.textContent).not.toContain('最新です');
});
