/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {NativeTextStyleList,TEXT_STYLE_CATALOG_URL} from './NativeTextStyleList';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import type {TextContent} from '../../core/sequence/textStyle';

beforeEach(()=>{vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new Error('テストではネットワークを使いません'))));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

// `clips` を持たせる（`NativeTelopPackUpdate` が参照先の集合を読むので、型どおり実在させる。
// `as unknown as` で型検査を迂回していたぶん、欠けていても tsc が教えてくれない）。
const document={id:'d',resolution:{width:640,height:360},fps:{num:30,den:1},clips:[]} as unknown as SequenceDocument;
const content={kind:'telop',data:{text:'サンプル',template:1}} as unknown as TextContent;
const assets:SequenceAsset[]=[
  {id:'builtin',kind:'component',name:'テロップスタイル',file:'a.mjs',fingerprint:'f1',streams:[],
    textStyleCatalog:{source:'builtin',packId:'editor-telop',version:'1',componentHash:'aaaaaaaaaaaaaaaa',entries:[{id:1,name:'白ふち'},{id:2,name:'黒帯'}]}},
  {id:'project',kind:'component',name:'案件スタイル',file:'b.mjs',fingerprint:'f2',streams:[],
    textStyleCatalog:{source:'project',packId:'project',version:'1',componentHash:'bbbbbbbbbbbbbbbb',entries:[{id:1,name:'案件スタイル 1'}]}},
  {id:'pack77',kind:'component',name:'追加パック',file:'c.mjs',fingerprint:'f3',streams:[],
    textStyleCatalog:{source:'installed',packId:'telop-extra-77',version:'2',componentHash:'cccccccccccccccc',entries:[{id:36,name:'ロイヤルブルー'}]}},
];
function setupProps(extra:Record<string,unknown>={}){
  return {projectId:'p',document,content,assets,hidden:{},disabled:false,applyAllCount:12,
    preparation:'ready' as const,onPrepare:vi.fn(async()=>true),
    onChoose:vi.fn(async()=>true),onApplyAll:vi.fn(async()=>true),onHiddenChange:vi.fn(async()=>true),...extra};
}
function setup(extra:Record<string,unknown>={}){
  const props=setupProps(extra);
  return {props,view:render(<NativeTextStyleList {...(props as any)}/>)};
}
/** F15: カタログはポップオーバーの中だけにある。一覧を触るテストは「変更…」から開く。 */
function openPicker(view:ReturnType<typeof render>){
  fireEvent.click(view.getByRole('button',{name:'変更…'}));
  return view.getByRole('dialog',{name:'スタイルを選ぶ'});
}

// T10 レビュー: ポップオーバーの開閉（ポータル位置・起点の再クリック・外側クリック・Esc）は
// 逸脱の当事者なので回帰で固定する。`document` はこのファイルで文書モデルに使っているので `window.document`。
it('opens the picker as a dialog placed directly under the body',()=>{
  const t=setup();
  const dialog=openPicker(t.view);
  expect(dialog.parentElement).toBe(window.document.body);
});
it('closes on a second click of the anchor instead of reopening right away',()=>{
  const t=setup();
  openPicker(t.view);
  const trigger=t.view.getByRole('button',{name:'変更…'});
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
});
it('closes when a pointer goes down outside the picker',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.pointerDown(window.document.body);
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
});
// 位置と高さは fixed なので、開いている間は窓の大きさとインスペクタのスクロールを追う必要がある。
// jsdom の getBoundingClientRect は 0 を返すので、観測できるのは innerHeight から決まる maxHeight。
it('re-measures while it is open when the window resizes or an ancestor scrolls',()=>{
  const height=window.innerHeight;
  const setHeight=(value:number)=>Object.defineProperty(window,'innerHeight',{value,configurable:true,writable:true});
  try{
    const t=setup();
    expect(openPicker(t.view).style.maxHeight).toBe('560px');
    setHeight(300);
    fireEvent(window,new Event('resize'));
    expect(t.view.getByRole('dialog',{name:'スタイルを選ぶ'}).style.maxHeight).toBe('276px');
    setHeight(900);
    fireEvent.scroll(window.document.body);
    expect(t.view.getByRole('dialog',{name:'スタイルを選ぶ'}).style.maxHeight).toBe('560px');
  }finally{setHeight(height);}
});
// I-3: ポータル先は `.native-workspace`。body 直下だと <fieldset disabled>・下書き確定の捕捉ハンドラ・
// 操作音の外に出る（`.native-workspace` は transform/contain を持たないので fixed の基準にはならない）。
it('portals into the workspace element when there is one',()=>{
  const host=window.document.createElement('main');host.className='native-workspace';
  window.document.body.append(host);
  try{
    const view=render(<NativeTextStyleList {...(setupProps() as any)}/>,
      {container:host.appendChild(window.document.createElement('div')),baseElement:window.document.body});
    expect(openPicker(view).parentElement).toBe(host);
  }finally{host.remove();}
});
// I-3: 無効化は fieldset 越しには届かないので、props で渡した disabled がピッカーの中まで効くこと。
it('disables the cards and the apply-to-track button while the inspector is disabled',()=>{
  const t=setup();
  openPicker(t.view);
  const applyAll=()=>t.view.getByRole('button',{name:'このスタイルを同じトラックに適用'}) as HTMLButtonElement;
  const hide=()=>t.view.getAllByRole('button',{name:/を使わない$/})[0] as HTMLButtonElement;
  expect(applyAll().disabled).toBe(false);
  expect(hide().disabled).toBe(false);
  const cards=()=>[...window.document.querySelectorAll<HTMLButtonElement>('.native-style-card')];
  expect(cards().length).toBeGreaterThan(0);   // 存在検査（0 枚なら「全部 disabled」は何も言っていない）
  t.view.rerender(<NativeTextStyleList {...(t.props as any)} disabled/>);
  expect(applyAll().disabled).toBe(true);
  expect(hide().disabled).toBe(true);
  expect(cards().every(card=>card.disabled)).toBe(true);
});
// I-4: 計画の共通要件「メニュー類は開いたら最初の項目へフォーカス」。ポータルは DOM 順で起点の隣にないので、
// フォーカスが入らないとキーボードだけでは 112 枚に届かない。
it('focuses the search box when the picker opens',()=>{
  const t=setup();
  const picker=openPicker(t.view);
  expect(window.document.activeElement).toBe(picker.querySelector('input'));
  expect((window.document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('スタイルを検索');
});
// I-8: 日本語で検索している最中の変換取り消し（Esc）でピッカーまで閉じてはいけない。
it('keeps the picker open for an Escape that cancels IME composition',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.keyDown(window.document,{key:'Escape',isComposing:true});
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).not.toBeNull();
  fireEvent.keyDown(window.document,{key:'Escape'});
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
});
// T10: 「閉じる」のどの経路でも、選び直したタブ（pickedAsset）は捨てる。残ると次に開いた時に前回のタブが出る。
it('forgets the picked source tab on every close path (anchor re-click / outside click / Escape)',()=>{
  const pickedTab=(view:ReturnType<typeof render>)=>
    (view.getAllByRole('radio').find(node=>node.getAttribute('aria-checked')==='true')as HTMLElement).textContent??'';
  const t=setup();
  for(const dismissWith of [
    (view:ReturnType<typeof render>)=>{const trigger=view.getByRole('button',{name:'変更…'});fireEvent.pointerDown(trigger);fireEvent.click(trigger);},
    ()=>fireEvent.pointerDown(window.document.body),
    ()=>fireEvent.keyDown(window.document,{key:'Escape'}),
  ]){
    openPicker(t.view);
    expect(pickedTab(t.view)).toContain('テロップスタイル');        // 既定は現在の資産（存在検査）
    fireEvent.click(t.view.getByRole('radio',{name:'追加したパック 1'}));
    expect(pickedTab(t.view)).toContain('追加したパック');
    dismissWith(t.view);
    expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
    openPicker(t.view);
    expect(pickedTab(t.view)).toContain('テロップスタイル');
    fireEvent.keyDown(window.document,{key:'Escape'});
  }
});
it('closes on Escape even while focus is still on the anchor, and gives focus back',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.keyDown(window.document,{key:'Escape'});
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
  expect(window.document.activeElement).toBe(t.view.getByRole('button',{name:'変更…'}));
});

it('現在のスタイルを 1 行で出し、カタログはポップオーバーを開くまで描かない',()=>{
  const t=setup();
  const row=t.view.container.querySelector('.native-style-current')!;
  expect(row.textContent).toContain('白ふち');
  expect(row.textContent).toContain('テロップスタイル');
  expect(t.view.queryByRole('heading')).toBeNull();
  expect(t.view.queryByLabelText('スタイルを検索')).toBeNull();
  openPicker(t.view);
  expect(t.view.getByRole('heading',{name:'テロップスタイル 2件'})).toBeTruthy();
});
it('自由書式のときは 1 行に「自由書式（スタイル未使用）」と出す',()=>{
  const t=setup({content:{kind:'telop',textMode:'free',data:{text:'サンプル',template:1}}});
  expect(t.view.container.querySelector('.native-style-current')!.textContent).toContain('自由書式（スタイル未使用）');
});
it('groups by source with a count and a catalog link',()=>{
  const t=setup();
  const picker=openPicker(t.view);
  expect(t.view.getByRole('heading',{name:'テロップスタイル 2件'})).toBeTruthy();
  fireEvent.click(t.view.getByRole('radio',{name:'この案件のスタイル 1'}));
  expect(t.view.getByRole('heading',{name:'この案件のスタイル 1件'})).toBeTruthy();
  fireEvent.click(t.view.getByRole('radio',{name:'追加したパック 1'}));
  expect(t.view.getByRole('heading',{name:'追加したパック 1件'})).toBeTruthy();
  expect(picker.querySelector('a')!.getAttribute('href')).toBe(TEXT_STYLE_CATALOG_URL);
  expect(t.view.getByRole('link',{name:'カタログを見る'}).getAttribute('href')).toBe(TEXT_STYLE_CATALOG_URL);
});
it('marks a different pack version so two identical numbers stay distinguishable',()=>{
  const t=setup({assets:[...assets,{id:'pack77b',kind:'component',name:'追加パック2',file:'d.mjs',fingerprint:'f4',streams:[],
    textStyleCatalog:{source:'installed' as const,packId:'telop-extra-77',version:'3',componentHash:'dddddddddddddddd',entries:[{id:36,name:'ロイヤルブルー'}]}}]});
  openPicker(t.view);
  const tabs=t.view.getAllByRole('radio',{name:'追加したパック 1'});
  const headings=tabs.map(tab=>{fireEvent.click(tab);return t.view.getByRole('heading',{name:/追加したパック/}).textContent;});
  expect(headings).toEqual(['追加したパック 1件','追加したパック（版 3） 1件']);
});
// T14 Minor: packId を持たない旧カタログは asset.id を代わりに使う（`catalog.packId??asset.id`）。
// その退避経路はテストが通っていなかった。id が違えば別パック扱いのまま並ぶこと。
it('keeps catalogs without a packId distinct by falling back to the asset id',()=>{
  const legacy=(id:string,name:string):SequenceAsset=>({id,kind:'component',name,file:`${id}.mjs`,fingerprint:id,streams:[],
    textStyleCatalog:{source:'installed',entries:[{id:36,name:'ロイヤルブルー'}]}});
  const t=setup({assets:[legacy('old-a','旧パックA'),legacy('old-b','旧パックB')]});
  openPicker(t.view);
  const headings=t.view.getAllByRole('radio',{name:'追加したパック 1'})
    .map(tab=>{fireEvent.click(tab);return t.view.getByRole('heading',{name:/追加したパック/}).textContent;});
  expect(headings).toEqual(['追加したパック 1件','追加したパック 1件']);
});
it('filters by the search box',()=>{
  const t=setup();
  const picker=openPicker(t.view);
  fireEvent.change(t.view.getByLabelText('スタイルを検索'),{target:{value:'黒'}});
  expect(within(picker).queryByLabelText('白ふち')).toBeNull();
  expect(within(picker).getByLabelText('黒帯')).toBeTruthy();
});
it('hides a style through the per-style toggle and brings it back with 「オフも表示」',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.click(t.view.getByRole('button',{name:'白ふちを使わない'}));
  expect(t.props.onHiddenChange).toHaveBeenCalledWith('builtin',[1]);
  cleanup();
  const off=setup({hidden:{builtin:[1]}});
  openPicker(off.view);
  expect(off.view.queryByLabelText('白ふち')).toBeNull();
  cleanup();
  const shown=setup({hidden:{builtin:[1]}});
  openPicker(shown.view);
  fireEvent.click(shown.view.getByRole('checkbox',{name:'オフも表示'}));
  expect(shown.view.getByLabelText('白ふち')).toBeTruthy();
  expect(shown.view.getByRole('button',{name:'白ふちを使う'})).toBeTruthy();
});
it('confirms the count before applying one style to every caption',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.click(t.view.getByRole('button',{name:'このスタイルを同じトラックに適用'}));
  // 確認は調整タブ側に出る。ポップオーバーが上に重ならないよう、押したら閉じる。
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
  expect(t.view.getByRole('alertdialog').textContent).toContain('12件');
  fireEvent.click(t.view.getByRole('button',{name:'12件に適用する'}));
  expect(t.props.onApplyAll).toHaveBeenCalledWith('builtin',1);
});
it('draws no preview for a cell that never becomes visible',()=>{
  const t=setup();
  openPicker(t.view);
  expect(window.document.querySelectorAll('[data-native-style-preview]')).toHaveLength(0);
});
it('automatically prepares the three built-in styles when the project has none',async()=>{
  const t=setup({preparation:'needs-builtin',assets:[]});
  await waitFor(()=>expect(t.props.onPrepare).toHaveBeenCalledTimes(1));
});
it('shows built-in style cards directly in the adjustment panel',()=>{
  const t=setup();
  const inline=t.view.container.querySelector('.native-style-inline')!;
  expect(inline.querySelectorAll('.native-style-card')).toHaveLength(2);
  expect(t.view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
  expect(t.view.getByRole('button',{name:'黒帯'})).toBeTruthy();
});
it('shows both a load button and the existing list when the project catalog is missing',()=>{
  const t=setup({preparation:'needs-project'});
  expect(t.view.getByRole('button',{name:'この案件のスタイルを読み込む'})).toBeTruthy();
  openPicker(t.view);
  expect(t.view.getByRole('heading',{name:'テロップスタイル 2件'})).toBeTruthy();
});
// Codex P2: 取り込み字幕は componentAssetId がカタログ資産の集合に無い。初期タブがそこへ張り付くと
// ピッカーが空になる（同梱カタログの節もタブも出ない）。currentStyleEntry と同じ規則で
// 利用可能なカタログへフォールバックする。
it('falls back the initial tab to an available catalog when the current component id is not among the catalog assets (unprepared captions)',()=>{
  const t=setup({preparation:'needs-project',content:{...content,componentAssetId:'imported-caption-not-in-assets'}});
  openPicker(t.view);
  expect(t.view.getByRole('heading',{name:'テロップスタイル 2件'})).toBeTruthy();
  expect(within(t.view.getByRole('dialog',{name:'スタイルを選ぶ'})).getByLabelText('白ふち')).toBeTruthy();
  expect(t.view.getByRole('radio',{name:'テロップスタイル 2'}).getAttribute('aria-checked')).toBe('true');
});
it('shows no prepare button when styles are ready',()=>{
  const t=setup();
  expect(t.view.queryByRole('button',{name:'テロップスタイルを用意する'})).toBeNull();
  expect(t.view.queryByRole('button',{name:'この案件のスタイルを読み込む'})).toBeNull();
});
it('shows an empty state message when search results are empty, and hides it when search clears',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.change(t.view.getByLabelText('スタイルを検索'),{target:{value:'マッチしない文字列'}});
  expect(t.view.getByText('一致するスタイルがありません。',{exact:true})).toBeTruthy();
  fireEvent.change(t.view.getByLabelText('スタイルを検索'),{target:{value:''}});
  expect(t.view.queryByText('一致するスタイルがありません。',{exact:true})).toBeNull();
});
// T10 レビュー Minor: 空状態は「今見ているタブ」で決める。他のタブに当たりが残っていても、
// 手前のタブが空なら空と言う（合計で数えると何も出ないまま黙る）。
it('reports the empty state for the visible tab even when another tab still matches',()=>{
  const t=setup();
  openPicker(t.view);
  fireEvent.change(t.view.getByLabelText('スタイルを検索'),{target:{value:'ロイヤル'}});
  expect(t.view.getByText('一致するスタイルがありません。',{exact:true})).toBeTruthy();
  fireEvent.click(t.view.getByRole('radio',{name:'追加したパック 1'}));
  expect(t.view.queryByText('一致するスタイルがありません。',{exact:true})).toBeNull();
  expect(t.view.getByLabelText('ロイヤルブルー')).toBeTruthy();
});
