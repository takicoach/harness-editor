/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeTextStyleList} from './NativeTextStyleList';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import type {TextContent} from '../../core/sequence/textStyle';
import type {InstalledTextStylePackInfo} from '../../core/sequence/installedTextStylePack';

beforeEach(()=>{vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new Error('テストではネットワークを使いません'))));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

const document={id:'d',resolution:{width:640,height:360},fps:{num:30,den:1},clips:[]} as unknown as SequenceDocument;
const content={kind:'telop',data:{text:'サンプル',template:1}} as unknown as TextContent;
const builtin:SequenceAsset={id:'builtin',kind:'component',name:'テロップスタイル',file:'a.mjs',fingerprint:'f1',streams:[],
  textStyleCatalog:{source:'builtin',packId:'harness.builtin',version:'1',componentHash:'aaaaaaaaaaaaaaaa',entries:[{id:1,name:'白ふち'}]}};
const extra:SequenceAsset={id:'extra',kind:'component',name:'試験用の追加パック',file:'e.mjs',fingerprint:'f9',streams:[],
  textStyleCatalog:{source:'installed',packId:'test.extra',version:'1',componentHash:'eeeeeeeeeeeeeeee',entries:[{id:1,name:'一'},{id:2,name:'二'}]}};
const PACK:InstalledTextStylePackInfo={packId:'test.extra',name:'試験用の追加パック',tabLabel:'試験',groupLabel:'試験パック',count:2,animations:['none']};

function setup(assets:SequenceAsset[],installedPacks:readonly InstalledTextStylePackInfo[]){
  const props={projectId:'p',document,content,assets,hidden:{},disabled:false,applyAllCount:1,preparation:'ready' as const,
    onPrepare:vi.fn(async()=>true),onChoose:vi.fn(async()=>true),onApplyAll:vi.fn(async()=>true),onHiddenChange:vi.fn(async()=>true),
    onRegisterAsset:vi.fn(async()=>true),onReplaceAsset:vi.fn(async()=>true),installedPacks};
  return {props,view:render(<NativeTextStyleList {...props}/>)};
}

it('追加パックが無い配布物では「…種を追加」を出さない',()=>{
  const {view}=setup([builtin],[]);
  expect(view.queryByRole('button',{name:/種を追加$/})).toBeNull();
});

it('未登録の追加パックがあれば、その名前と件数でボタンを出し、押すと用意する',()=>{
  const {props,view}=setup([builtin],[PACK]);
  fireEvent.click(view.getByRole('button',{name:'試験用の追加パック2種を追加'}));
  expect(props.onPrepare).toHaveBeenCalledTimes(1);
});

it('登録済みの追加パックはボタンを出さず、タブと見出しにパックの名前を使う',()=>{
  const {view}=setup([builtin,extra],[PACK]);
  expect(view.queryByRole('button',{name:/種を追加$/})).toBeNull();
  fireEvent.click(view.getByRole('button',{name:'変更…'}));
  fireEvent.click(view.getByRole('radio',{name:'試験 2'}));
  expect(view.getByRole('heading',{name:'試験用の追加パック 2件'})).toBeTruthy();
});

it('パックの無い配布物でも、登録済みの追加パックはボタンを出さず「追加したパック」として選べる',()=>{
  const {view}=setup([builtin,extra],[]);
  expect(view.queryByRole('button',{name:/種を追加$/})).toBeNull();
  fireEvent.click(view.getByRole('button',{name:'変更…'}));
  fireEvent.click(view.getByRole('radio',{name:'追加したパック 2'}));
  expect(view.getByRole('heading',{name:'追加したパック 2件'})).toBeTruthy();
});
