/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,within} from '@testing-library/react';
import {NativeInspector} from './NativeInspector';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {DEFAULT_TEXT_APPEARANCE,type ClipContent,type SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {FONTS,fontStack} from '../../core/fonts';
import {rational as r} from '../../core/sequence/time';

// スタイルの見本セルは凍結部品を fetch して描く（jsdom では読めず、ボタンが disabled のまま）。
// ここで見たいのは「一覧が返した styleId が NativeInspector の onChoose へ実際に届くか」なので、
// セルだけを押せるボタンへ差し替え、一覧本体（NativeTextStyleList）の配線は本物のまま通す。
vi.mock('./NativeTextStylePicker',async original=>({...await original<typeof import('./NativeTextStylePicker')>(),
  StyleCells:({asset,entries,onSelect}:{asset:{id:string};entries:{id:number;name:string}[];onSelect(assetId:string,styleId:number):void})=>
    <>{entries.map(entry=><button key={entry.id} type="button" onClick={()=>onSelect(asset.id,entry.id)}>{entry.name}</button>)}</>}));

afterEach(cleanup);

/** F15: カタログはポップオーバーの中。セルを押すテストは先に「変更…」を押す。 */
const openStylePicker=(view:ReturnType<typeof render>)=>fireEvent.click(view.getByRole('button',{name:'変更…'}));

const NINE=['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar'];
const EIGHT=NINE.filter(id=>id!=='charByChar');

/** 凍結カタログ 2 件（1 は charByChar 非対応・17 は対応）を持つ builtin 資産。 */
function styleDocument():SequenceDocument {
  const content:ClipContent={kind:'telop',textMode:'component',componentAssetId:'builtin',
    data:{text:'文字',template:17,animation:'charByChar'}};
  const doc=documentWith(content);
  doc.assets=[{id:'builtin',kind:'component',file:'public/builtin.tsx',name:'テロップスタイル',fingerprint:'fp',streams:[],
    textStyleCatalog:{source:'builtin',packId:'harness.builtin',version:'1.1.0',componentHash:'0123456789abcdef',
      entries:[{id:1,name:'白文字黒シャドウ',animations:EIGHT},{id:17,name:'白赤テロップ',animations:NINE}],animations:NINE}}];
  return doc;
}

function documentWith(content:ClipContent):SequenceDocument {
  return {schemaVersion:2,id:'doc',name:'fixture',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,
    background:'#000000',assets:[],tracks:[{id:'track',name:'内容',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    clips:[{id:'clip',trackId:'track',name:'内容',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content,
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}}]};
}

it('saves a fallback stack (not the raw family) when a telop font is chosen',async()=>{
  const content:ClipContent={kind:'telop',textMode:'free',data:{text:'文字'},appearance:{...DEFAULT_TEXT_APPEARANCE}};
  const doc=documentWith(content);
  const commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{commands.push(command);return true;};
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const target=FONTS.find(f=>f.id==='noto-serif-jp')!;
  await act(async()=>{fireEvent.change(view.getByLabelText('フォント'),{target:{value:target.family}});});
  expect(commands).toHaveLength(1);
  const patch=(commands[0] as {patch:{content:ClipContent}}).patch.content;
  if(patch.kind!=='telop')throw new Error('expected telop');
  expect(patch.appearance!.fontFamily).toBe(fontStack(target));
  expect(patch.appearance!.fontFamily).not.toBe(target.family);
});

it('saves the raw family (not a stack) when a title font is chosen',async()=>{
  const content:ClipContent={kind:'title',data:{text:'タイトル'},style:{top:10,left:10,fontSize:30}};
  const doc=documentWith(content);
  const commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{commands.push(command);return true;};
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const target=FONTS.find(f=>f.id==='noto-serif-jp')!;
  await act(async()=>{fireEvent.change(view.getByLabelText('フォント'),{target:{value:target.family}});});
  expect(commands).toHaveLength(1);
  const patch=(commands[0] as {patch:{content:ClipContent}}).patch.content;
  if(patch.kind!=='title')throw new Error('expected title');
  expect(patch.style.fontFamily).toBe(target.family);
});

it('drops the open animation guard when the selected clip changes, without dispatching',async()=>{
  const guardedContent:ClipContent={kind:'telop',textMode:'free',componentAssetId:'comp1',
    appearance:{...DEFAULT_TEXT_APPEARANCE},data:{text:'文字',animation:'slideIn'}};
  const otherContent:ClipContent={kind:'telop',textMode:'free',data:{text:'別のクリップ'},appearance:{...DEFAULT_TEXT_APPEARANCE}};
  const doc=documentWith(guardedContent);
  doc.assets=[{id:'comp1',kind:'component',file:'comp1',name:'部品',fingerprint:'fp',streams:[],
    textStyleCatalog:{source:'project',entries:[{id:1,name:'style'}],animations:['fadeOnly']}}];
  doc.clips.push({...doc.clips[0]!,id:'clip-2',content:otherContent});
  const commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{commands.push(command);return true;};
  // F14: 「スタイルを使う」は群「見た目」の中。既定では畳まれているので、この検証ではその群だけ開く。
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false} groupOpen={{'telop:look':true}}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'スタイルを使う'}));});
  expect(view.getByRole('alertdialog')).toBeTruthy();
  view.rerender(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip-2']} disabled={false} groupOpen={{'telop:look':true}}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  expect(view.queryByRole('alertdialog')).toBeNull();
  expect(commands).toHaveLength(0);
});

it('shows a legacy 3-choice fallback stack as its matching bundled font, selected',()=>{
  const content:ClipContent={kind:'telop',textMode:'free',data:{text:'文字'},
    appearance:{...DEFAULT_TEXT_APPEARANCE,fontFamily:'"Noto Serif JP", "Hiragino Mincho ProN", serif'}};
  const doc=documentWith(content);
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const select=view.getByLabelText('フォント') as HTMLSelectElement;
  const target=FONTS.find(f=>f.id==='noto-serif-jp')!;
  expect(select.value).toBe(target.family);
  expect(view.queryByText('この案件の設定（一覧にありません）')).toBeNull();
});

it('charByChar の字幕で非対応スタイルを選ぶと確認ダイアログが出る（styleId を渡している証拠）',async()=>{
  // styleId を渡していないと 35 種すべてが charByChar を名乗るカタログ単位の集合になり、
  // ダイアログが出ないまま「選べるのに動かない」字幕へ切り替わる（Codex P1-2 の再現）。
  const doc=styleDocument();
  const commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{commands.push(command);return true;};
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  openStylePicker(view);
  await act(async()=>{fireEvent.click(within(view.getByRole('dialog',{name:'スタイルを選ぶ'})).getByRole('button',{name:'白文字黒シャドウ'}));});
  expect(view.getByRole('alertdialog')).toBeTruthy();
  expect(commands).toHaveLength(0);
  // 切替を断られた（onChoose が false）ので、選び直せるようピッカーは開いたまま。
  expect(view.getByRole('dialog',{name:'スタイルを選ぶ'})).toBeTruthy();
});

it('対応スタイル（17）を選んだときはダイアログを出さずに切り替える',async()=>{
  const doc=styleDocument();
  (doc.clips[0]!.content as {data:{template?:number}}).data.template=1;
  const commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{commands.push(command);return true;};
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const change=view.getByRole('button',{name:'変更…'});
  openStylePicker(view);
  await act(async()=>{fireEvent.click(within(view.getByRole('dialog',{name:'スタイルを選ぶ'})).getByRole('button',{name:'白赤テロップ'}));});
  expect(view.queryByRole('alertdialog')).toBeNull();
  expect(commands).toHaveLength(1);
  // 反映できたのでピッカーは閉じ、起点の「変更…」へフォーカスが戻る。
  expect(view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
  expect(document.activeElement).toBe(change);
  const patch=(commands[0] as {patch:{content:ClipContent}}).patch.content;
  if(patch.kind!=='telop')throw new Error('expected telop');
  expect(patch.data.template).toBe(17);
  expect(patch.data.animation).toBe('charByChar');
});

it('調整タブ内のスタイルカードから直接切り替えられる',async()=>{
  const doc=styleDocument();
  (doc.clips[0]!.content as {data:{template?:number}}).data.template=1;
  const commands:NativeCommand[]=[];
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async command=>{commands.push(command);return true;}} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  expect(view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
  await act(async()=>{fireEvent.click(within(view.getByRole('region',{name:'標準テロップスタイル2種'})).getByRole('button',{name:'白赤テロップ'}));});
  expect(commands).toHaveLength(1);
  expect(view.queryByRole('dialog',{name:'スタイルを選ぶ'})).toBeNull();
});

it('scopes bulk style and its confirmation to the selected track, excluding imported heading telops',async()=>{
  const doc=styleDocument();
  if(doc.clips[0]!.content.kind!=='telop')throw new Error('fixture');
  doc.clips[0]!.content.data.animation='none';doc.clips[0]!.content.data.template=1;
  const heading=structuredClone(doc.clips[0]!);heading.id='heading';heading.trackId='heading-track';
  if(heading.content.kind!=='telop')throw new Error('fixture');
  heading.content.data.animation='charByChar';
  doc.tracks.push({id:'heading-track',name:'章タイトル',kind:'visual',enabled:true});doc.clips.push(heading);
  const commands:NativeCommand[]=[];
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async command=>{commands.push(command);return true;}} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  openStylePicker(view);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'このスタイルを同じトラックに適用'}));});
  expect(view.getByRole('alertdialog').textContent).toContain('「内容」の文字 1件');
  expect(view.getByRole('alertdialog').textContent).toContain('他のトラック');
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'1件に適用する'}));});
  expect(commands).toEqual([{type:'apply-text-style-all',assetId:'builtin',styleId:1,trackId:'track'}]);
});

/** 映像クリップ 2 件（同じ素材）の案件。複数選択の回帰（F14 の Important 1）用。 */
function videoPairDocument():SequenceDocument {
  const doc=documentWith({kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)});
  doc.assets=[{id:'asset',kind:'media',file:'media/input.mp4',name:'素材',fingerprint:'fp',
    streams:[{index:0,kind:'video',codec:'h264',duration:r(30),frameRate:r(30),width:320,height:180}]}];
  doc.clips.push({...structuredClone(doc.clips[0]!),id:'clip-2'});
  return doc;
}
const MULTI_GROUPS=['look','place','motion','time','project'];

/** テロップ 2 件の複数選択。`multi` の節集合では「見た目」に出せる節が無い（M-5）。 */
function telopPairDocument():SequenceDocument {
  const doc=documentWith({kind:'telop',textMode:'component',componentAssetId:'builtin',data:{text:'文字',template:1}});
  doc.clips.push({...structuredClone(doc.clips[0]!),id:'clip-2'});
  return doc;
}
it('複数選択で中身が全部落ちる群の見出しは出さない（M-5）',()=>{
  const doc=telopPairDocument();
  const open=Object.fromEntries(MULTI_GROUPS.map(group=>[`multi:${group}`,true]));
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip','clip-2']} disabled={false} groupOpen={open}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  expect(view.getByText('複数選択')).toBeTruthy();                       // 存在検査（複数選択の画面が出ている）
  expect(view.getByRole('button',{name:/^時間/})).toBeTruthy();          // 中身のある群は出る
  expect(view.queryByRole('button',{name:/^見た目/})).toBeNull();        // 空の群は出さない
  expect(view.container.querySelector('.native-inspector-section[data-group=look]')).toBeNull();
});

it('複数選択でも「見た目」の群が出て、色設定を選択した映像すべてへ貼り付けられる',async()=>{
  const doc=videoPairDocument();
  const commands:NativeCommand[]=[];
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip','clip-2']} disabled={false} groupOpen={{'multi:look':true}}
    bypassLut={false} onBypass={()=>{}} onCommand={async command=>{commands.push(command);return true;}} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'設定をコピー'}));});
  const paste=view.getByRole('button',{name:'貼り付け'}) as HTMLButtonElement;
  expect(paste.disabled).toBe(false);
  await act(async()=>{fireEvent.click(paste);});
  expect(commands).toHaveLength(1);
  const batch=commands[0] as {type:string;commands:{type:string;clipId:string}[]};
  expect(batch.type).toBe('batch');
  expect(batch.commands.map(entry=>entry.clipId)).toEqual(['clip','clip-2']);
});

it('「すべて畳む」は確定が通ってから全群を閉じ、全部閉じていれば「すべて開く」で全群を開く',async()=>{
  const doc=videoPairDocument();
  const onGroupOpen=vi.fn();
  const open=Object.fromEntries(MULTI_GROUPS.map(group=>[`multi:${group}`,true]));
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip','clip-2']} disabled={false} groupOpen={open} onGroupOpen={onGroupOpen}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'すべて畳む'}));});
  expect(onGroupOpen.mock.calls).toEqual(MULTI_GROUPS.map(group=>[`multi:${group}`,false]));

  onGroupOpen.mockClear();
  const closed=Object.fromEntries(MULTI_GROUPS.map(group=>[`multi:${group}`,false]));
  view.rerender(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip','clip-2']} disabled={false} groupOpen={closed} onGroupOpen={onGroupOpen}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'すべて開く'}));});
  expect(onGroupOpen.mock.calls).toEqual(MULTI_GROUPS.map(group=>[`multi:${group}`,true]));
});

it('「すべて畳む」は確定できない下書きがあるあいだ群を閉じない',async()=>{
  const doc=videoPairDocument();
  const onGroupOpen=vi.fn();
  const open=Object.fromEntries(MULTI_GROUPS.map(group=>[`multi:${group}`,true]));
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip','clip-2']} disabled={false} groupOpen={open} onGroupOpen={onGroupOpen}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  // 焦点の無い欄を書き換えると blur では確定に届かない（flush が false を返す条件）。
  await act(async()=>{fireEvent.change(view.getByLabelText('スケール（%）'),{target:{value:'120'}});});
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'すべて畳む'}));});
  expect(onGroupOpen).not.toHaveBeenCalled();
  expect(view.getByRole('alert').textContent).toContain('入力を確定できませんでした');
});

// T15: 入れ子の節（動きのカタログ）も、閉じる前に beforeClose（flush）を通す。
// 確定できない下書きがあるあいだは閉じない — 群と同じ規律が入れ子でも効くこと。
it('入れ子の「動きのカタログ」も閉じる前に確定を通す（T15）',async()=>{
  const content:ClipContent={kind:'telop',textMode:'free',data:{text:'文字'},appearance:{...DEFAULT_TEXT_APPEARANCE}};
  const doc=documentWith(content);
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false} groupOpen={{'telop:content':true,'telop:look':true}}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const head=view.getByRole('button',{name:/^動きのカタログ/});
  fireEvent.click(head);
  expect(head.getAttribute('aria-expanded')).toBe('true');   // 前提: 開けている
  // 焦点の無い欄を書き換えると blur では確定に届かない（flush が false を返す条件）。
  await act(async()=>{fireEvent.change(view.getByLabelText('文字サイズ（px）'),{target:{value:'48'}});});
  await act(async()=>{fireEvent.click(head);});
  expect(head.getAttribute('aria-expanded')).toBe('true');   // 確定できないので閉じない
  expect(view.getByRole('alert').textContent).toContain('入力を確定できませんでした');
});

it('動きのカタログは畳んだ節で、要約に現在の動きが出て、押すと開く（Task 15）',()=>{
  const content:ClipContent={kind:'telop',textMode:'free',data:{text:'文字'},appearance:{...DEFAULT_TEXT_APPEARANCE}};
  const doc=documentWith(content);
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={['clip']} disabled={false} groupOpen={{'telop:content':true}}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  const head=view.getByRole('button',{name:/^動きのカタログ/});
  expect(head.getAttribute('aria-expanded')).toBe('false');
  expect(head.textContent).toContain('なし');
  expect(view.getByRole('group',{name:'アニメーション',hidden:true}).closest('[hidden]')).not.toBeNull();
  fireEvent.click(head);
  expect(head.getAttribute('aria-expanded')).toBe('true');
  expect(view.getByRole('group',{name:'アニメーション'})).toBeTruthy();
});

// Rec 1（M-9 の負側）: 未選択（kind='none'）は inspectorGroups が ['project'] の 1 件だけを返すので、
// 実際に描く群も 1 つしかない。「すべて畳む」導線は 2 つ以上のときだけ出すべきで、1 つでは出さない。
it('描いた群が 1 つ（未選択）なら「すべて畳む」導線を出さない',()=>{
  const doc=documentWith({kind:'telop',textMode:'free',data:{text:'文字'},appearance:{...DEFAULT_TEXT_APPEARANCE}});
  const view=render(<NativeInspector projectId="fixture" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={[]} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>);
  expect(view.queryByRole('button',{name:'すべて畳む'})).toBeNull();
  expect(view.queryByRole('button',{name:'すべて開く'})).toBeNull();
});
