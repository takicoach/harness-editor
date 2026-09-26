/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeTelopTemplateUpdate} from './NativeTelopTemplateUpdate';

const plan={planId:'p-1',documentId:'d1',revision:7,versionLabel:'製品テンプレート 2026-08 版（518 行）',
  files:[{path:'Telop.tsx',action:'modify'},{path:'telopTypes.ts',action:'modify'},
    {path:'telopAnimations.ts',action:'add'},{path:'telopAnimationEffect.ts',action:'add'}],
  styleIds:[1,2,3],animations:new Array(17).fill('x'),captionCount:42,fromAssetId:'old-1'};
const applied={planId:'p-1',asset:{id:'new-1'},fromAssetId:'old-1',captionCount:42,versionLabel:plan.versionLabel};

/** telop クリップ 1 件がだけを持つ最小の document（componentAssetId が assetId を参照）。 */
function makeDocument(assetId:string|null){
  return {schemaVersion:2,id:'d1',name:'t',revision:7,fps:{num:30,den:1},resolution:{width:1,height:1},
    sequenceEndFrame:1,background:'#000',assets:[],tracks:[],transitions:[],transcripts:[],
    clips:assetId?[{id:'c1',content:{kind:'telop',componentAssetId:assetId,data:{text:'あ',template:1}}}]:[]} as never;
}

// 既定では status を「控え無し」で応答する。復元系のテストだけ個別に上書きする。
function stubFetch(map:Record<string,unknown>,status=200){
  return vi.fn(async(url:string)=>{
    const key=Object.keys(map).find(path=>String(url).includes(path));
    if(key)return {ok:status<400,status,json:async()=>map[key]} as Response;
    if(String(url).includes('/status'))return {ok:true,status:200,json:async()=>({applied:null})} as Response;
    return {ok:status<400,status,json:async()=>({error:'unknown'})} as Response;
  });
}
const props=(over={})=>({projectId:'p1',document:makeDocument('old-1'),disabled:false,expectedRevision:7,
  onRegisterAsset:vi.fn(async()=>true),onReplaceAsset:vi.fn(async()=>true),...over});

afterEach(cleanup);
beforeEach(()=>{vi.restoreAllMocks();});

it('最初は 1 つのボタンだけを出す（押すまで書き込み系の fetch は起きない）',async()=>{
  const fetchSpy=stubFetch({});vi.stubGlobal('fetch',fetchSpy);
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  expect(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeTruthy();
  // マウント時の状態確認（GET /status）だけは起きる。plan/apply/revert のような書き込み系は起きない。
  expect(fetchSpy.mock.calls.every(call=>String(call[0]).includes('/status'))).toBe(true);
});

it('復元(a): 控えがあり字幕がまだ旧部品を参照していれば「切り替える」を出す',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/status':{applied:{planId:'p-1',assetId:'new-1',fromAssetId:'old-1',captionCount:42}}}));
  const view=render(<NativeTelopTemplateUpdate {...props({document:makeDocument('old-1')})}/>);
  expect(await view.findByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'})).toBeTruthy();
  expect(view.getByRole('button',{name:'更新前に戻す'})).toBeTruthy();
  expect(view.queryByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeNull();
});

it('復元(b): 控えがあり字幕が既に新部品を参照していれば「更新前に戻す」だけを出す',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/status':{applied:{planId:'p-1',assetId:'new-1',fromAssetId:'old-1',captionCount:42}}}));
  const view=render(<NativeTelopTemplateUpdate {...props({document:makeDocument('new-1')})}/>);
  expect(await view.findByRole('button',{name:'更新前に戻す'})).toBeTruthy();
  expect(view.queryByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'})).toBeNull();
  expect(view.queryByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeNull();
});

it('復元(c): 控えが無ければ開始ボタンに戻る',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/status':{applied:null}}));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  expect(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeTruthy();
});

it('復元(d): マウント時に onRegisterAsset／onReplaceAsset を呼ばない',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/status':{applied:{planId:'p-1',assetId:'new-1',fromAssetId:'old-1',captionCount:42}}}));
  const onRegisterAsset=vi.fn(async()=>true),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({document:makeDocument('old-1'),onRegisterAsset,onReplaceAsset})}/>);
  await view.findByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'});
  expect(onRegisterAsset).not.toHaveBeenCalled();
  expect(onReplaceAsset).not.toHaveBeenCalled();
});

it('押すと計画の内容（件数・変わるもの・次のボタン）を出す',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan}));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  const dialog=await view.findByRole('alertdialog',{name:'テロップ部品の更新の確認'});
  expect(dialog.textContent).toContain('4つのファイル');
  expect(dialog.textContent).toContain('スタイルの数（3件）は変わりません');
  expect(dialog.textContent).toContain('この案件の字幕 42件');
  expect(view.getByRole('button',{name:'更新する'})).toBeTruthy();
  expect(view.getByRole('button',{name:'やめる'})).toBeTruthy();
});

it('やめるを押しても apply を呼ばない',async()=>{
  const fetchSpy=stubFetch({'/plan':plan});vi.stubGlobal('fetch',fetchSpy);
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'やめる'}));
  await waitFor(()=>expect(view.queryByRole('alertdialog')).toBeNull());
  expect(fetchSpy.mock.calls.every(call=>!String(call[0]).includes('/apply'))).toBe(true);
});

it('更新すると新資産を登録し、続けて参照切替を「件数つきで」勧める',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan,'/apply':applied}));
  const onRegisterAsset=vi.fn(async()=>true),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  await waitFor(()=>expect(onRegisterAsset).toHaveBeenCalledTimes(1));
  const next=await view.findByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'});
  expect(onReplaceAsset).not.toHaveBeenCalled();
  fireEvent.click(next);
  await waitFor(()=>expect(onReplaceAsset).toHaveBeenCalledWith('old-1','new-1'));
});

it('適用後は同じ場所に「更新前に戻す」が出る',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan,'/apply':applied}));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  expect(await view.findByRole('button',{name:'更新前に戻す'})).toBeTruthy();
});

it('登録に失敗したら「更新前に戻す」と「もう一度登録する」を出し、事実どおりの文言にする（I-2／Codex P2）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan,'/apply':applied}));
  const onRegisterAsset=vi.fn(async()=>false),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  await waitFor(()=>expect(onRegisterAsset).toHaveBeenCalledTimes(1));
  // 部品は更新済み。戻す導線と再試行の導線がその場に出る。
  expect(await view.findByRole('button',{name:'更新前に戻す'})).toBeTruthy();
  expect(view.getByRole('button',{name:'もう一度登録する'})).toBeTruthy();
  // まだ登録できていないので参照切替へは進ませない。
  expect(view.queryByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'})).toBeNull();
  const alert=view.getByRole('alert');
  expect(alert.textContent).toContain('部品は更新済み');
  expect(alert.textContent).toContain('登録に失敗');
  expect(alert.textContent).not.toContain('案件は変えていません');
  expect(onReplaceAsset).not.toHaveBeenCalled();
});

it('もう一度登録するが成功したら切替の導線へ進む（I-2／Codex P2）',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan,'/apply':applied}));
  const onRegisterAsset=vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  fireEvent.click(await view.findByRole('button',{name:'もう一度登録する'}));
  await waitFor(()=>expect(onRegisterAsset).toHaveBeenCalledTimes(2));
  const next=await view.findByRole('button',{name:'いまの字幕 42件を新しい部品に切り替える'});
  expect(view.queryByRole('button',{name:'もう一度登録する'})).toBeNull();
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.getByRole('status').textContent).toContain('部品を更新しました。');
  fireEvent.click(next);
  await waitFor(()=>expect(onReplaceAsset).toHaveBeenCalledWith('old-1','new-1'));
});

it('中止（409）の理由をそのまま出し、案件は触っていないと伝える',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':{error:'この案件のテロップ部品は自動更新に対応していません（手を入れた版か、対応外の版です）。'}},409));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  const alert=await view.findByRole('alert');
  expect(alert.textContent).toContain('自動更新に対応していません');
  expect(alert.textContent).toContain('案件は変えていません');
});

it('戻すが backup-missing で失敗したら開始状態へ戻り、dispatch は呼ばない',async()=>{
  const fetchSpy=vi.fn(async(url:string)=>{
    const map:Record<string,unknown>={'/plan':plan,'/apply':applied};
    if(String(url).includes('/revert'))
      return {ok:false,status:409,json:async()=>({error:'更新前の控えが残っていません。',reason:'backup-missing'})} as Response;
    const key=Object.keys(map).find(path=>String(url).includes(path));
    return {ok:true,status:200,json:async()=>key?map[key]:{error:'unknown'}} as Response;
  });
  vi.stubGlobal('fetch',fetchSpy);
  const onRegisterAsset=vi.fn(async()=>true),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  fireEvent.click(await view.findByRole('button',{name:'更新前に戻す'}));
  await waitFor(()=>expect(view.queryByRole('button',{name:'更新前に戻す'})).toBeNull());
  expect(view.getByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeTruthy();
  const alert=view.getByRole('alert');
  expect(alert.textContent).toContain('更新前の控えが残っていません');
  expect(alert.textContent).toContain('もう一度確認からやり直してください');
  expect(onRegisterAsset).toHaveBeenCalledTimes(1);
  expect(onReplaceAsset).not.toHaveBeenCalled();
});

it('戻すが plan-not-found で失敗したら開始状態へ戻り、dispatch は呼ばない',async()=>{
  const fetchSpy=vi.fn(async(url:string)=>{
    const map:Record<string,unknown>={'/plan':plan,'/apply':applied};
    if(String(url).includes('/revert'))
      return {ok:false,status:409,json:async()=>({error:'この計画は既に失効しています。',reason:'plan-not-found'})} as Response;
    const key=Object.keys(map).find(path=>String(url).includes(path));
    return {ok:true,status:200,json:async()=>key?map[key]:{error:'unknown'}} as Response;
  });
  vi.stubGlobal('fetch',fetchSpy);
  const onRegisterAsset=vi.fn(async()=>true),onReplaceAsset=vi.fn(async()=>true);
  const view=render(<NativeTelopTemplateUpdate {...props({onRegisterAsset,onReplaceAsset})}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  fireEvent.click(await view.findByRole('button',{name:'更新前に戻す'}));
  await waitFor(()=>expect(view.queryByRole('button',{name:'更新前に戻す'})).toBeNull());
  expect(view.getByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeTruthy();
  const alert=view.getByRole('alert');
  expect(alert.textContent).toContain('この計画は既に失効しています');
  expect(alert.textContent).toContain('もう一度確認からやり直してください');
  expect(onRegisterAsset).toHaveBeenCalledTimes(1);
  expect(onReplaceAsset).not.toHaveBeenCalled();
});

it('戻すが reason 無しの一時的な失敗の時は applied を保ち、再試行できる',async()=>{
  const fetchSpy=vi.fn(async(url:string)=>{
    const map:Record<string,unknown>={'/plan':plan,'/apply':applied};
    if(String(url).includes('/revert'))
      return {ok:false,status:500,json:async()=>({error:'サーバーで問題が起きました。'})} as Response;
    const key=Object.keys(map).find(path=>String(url).includes(path));
    return {ok:true,status:200,json:async()=>key?map[key]:{error:'unknown'}} as Response;
  });
  vi.stubGlobal('fetch',fetchSpy);
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  fireEvent.click(await view.findByRole('button',{name:'更新前に戻す'}));
  const alert=await view.findByRole('alert');
  expect(alert.textContent).toContain('サーバーで問題が起きました');
  expect(view.getByRole('button',{name:'更新前に戻す'})).toBeTruthy();
  expect(view.queryByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeNull();
});

it('戻すが成功すれば従来どおり開始状態へ戻る',async()=>{
  vi.stubGlobal('fetch',stubFetch({'/plan':plan,'/apply':applied,
    '/revert':{restored:['Telop.tsx'],stillReferenced:false,notice:'元に戻しました。'}}));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  fireEvent.click(await view.findByRole('button',{name:'更新する'}));
  fireEvent.click(await view.findByRole('button',{name:'更新前に戻す'}));
  await waitFor(()=>expect(view.queryByRole('button',{name:'更新前に戻す'})).toBeNull());
  expect(view.getByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'})).toBeTruthy();
  expect(view.getByRole('status').textContent).toContain('元に戻しました。');
});

it('案件が切り替わったら結果を捨てる（世代照合）',async()=>{
  const releases:((value:unknown)=>void)[]=[];
  vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{releases.push(resolve as (value:unknown)=>void);})));
  const view=render(<NativeTelopTemplateUpdate {...props()}/>);
  releases[0]!({ok:true,status:200,json:async()=>({applied:null})});          // マウント時の status を解決
  fireEvent.click(await view.findByRole('button',{name:'この案件の字幕で新しい動きを使えるようにする'}));
  view.rerender(<NativeTelopTemplateUpdate {...props({projectId:'p2'})}/>);
  releases[1]!({ok:true,status:200,json:async()=>plan});
  await waitFor(()=>expect(view.queryByRole('alertdialog')).toBeNull());
});
