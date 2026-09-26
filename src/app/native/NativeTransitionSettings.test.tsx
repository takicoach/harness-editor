/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeTransitionSettings} from './NativeTransitionSettings';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {applySequenceCommand,type SequenceCommand} from '../../core/sequence/commands';
import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {transitionJoinKey} from '../../core/sequence/transitions';
import {rational as r} from '../../core/sequence/time';
import type {NativeCommand} from './api';
import {TWO_CLIP_JOIN_KEY,twoClipDocument,type TwoClipOptions} from './__fixtures__/transitionFixture';

afterEach(cleanup);
/** 3 本の映像。それぞれの余白は asset の長さと sourceIn だけで決める（フレームではなく秒）。 */
function threeClipDocument(rooms:{c1Tail:number;c2Head:number;c2Tail:number;c3Head:number}):SequenceDocument{
  const asset=(id:string,seconds:number)=>({id,kind:'media' as const,file:`public/${id}.mp4`,name:id,fingerprint:id,
    streams:[{index:0,kind:'video' as const,codec:'h264',duration:r(seconds),frameRate:r(30),width:1920,height:1080}]});
  const clip=(id:string,assetId:string,startFrame:number,sourceInSeconds:number):SequenceClip=>({
    id,name:id,trackId:'t1',startFrame,durationFrames:150,
    clock:{offset:r(0),rate:r(1),duration:r(150)},
    content:{kind:'video',assetId,streamIndex:0,sourceIn:r(sourceInSeconds),rate:r(1)},
  });
  return {
    schemaVersion:2,id:'doc',name:'一括適用の除外',revision:0,fps:r(30),
    resolution:{width:1920,height:1080},sequenceEndFrame:450,background:'#000000',
    ducking:{enabled:false,strength:'mid'},
    assets:[asset('a1',20+5+rooms.c1Tail),asset('a2',5+rooms.c2Tail),asset('a3',rooms.c3Head+5)],
    tracks:[{id:'t1',kind:'visual',name:'映像1',enabled:true}],
    clips:[clip('c1','a1',0,20),clip('c2','a2',150,rooms.c2Head),clip('c3','a3',300,rooms.c3Head)],
    transitions:[],transcripts:[],
  };
}
const JOIN_1=transitionJoinKey('t1','c1','c2'),JOIN_2=transitionJoinKey('t1','c2','c3');

/** 組み立てられたコマンドだけを取り出す（文書は変えない）。 */
function settings(options:TwoClipOptions={},overrides:Partial<{joinKey:string;disabled:boolean}>={}){
  const document=twoClipDocument(options),built:NativeCommand[]=[];
  const onJoin=vi.fn(async()=>true);
  const onEdit=vi.fn(async(build:(document:SequenceDocument)=>NativeCommand)=>{built.push(build(document));return true;});
  const view=render(<NativeTransitionSettings document={document} joinKey={TWO_CLIP_JOIN_KEY} disabled={false}
    onJoin={onJoin} onEdit={onEdit} {...overrides}/>);
  return {view,document,built,onJoin,onEdit};
}
const kindSelect=(view:ReturnType<typeof render>)=>view.getByLabelText('転換の種類') as HTMLSelectElement;
const option=(view:ReturnType<typeof render>,value:string)=>
  [...kindSelect(view).options].find(item=>item.value===value)!;
const statusText=(view:ReturnType<typeof render>)=>view.queryAllByRole('status').map(node=>node.textContent??'').join('\n');

it('種類は なし／暗転／白転／色指定／クロスフェード／スライド／ワイプ の 7 つ',()=>{
  const {view}=settings();
  expect([...kindSelect(view).options].map(item=>item.textContent))
    .toEqual(['なし','フェード（暗転）','フェード（白転）','フェード（色指定）','クロスフェード','スライド','ワイプ']);
});

it('方向はスライド・ワイプのときだけ出る',async()=>{
  const {view}=settings();
  expect(view.queryByLabelText('転換の方向')).toBeNull();
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'slide'}});});
  expect(view.getByLabelText('転換の方向')).toBeTruthy();
});

it('長さは 2〜60 フレーム',()=>{
  const {view}=settings({transition:{kind:'crossfade',durationFrames:12}});
  const input=view.getByLabelText('転換の長さ（fr）') as HTMLInputElement;
  expect(input.min).toBe('2');expect(input.max).toBe('60');expect(input.value).toBe('12');
});

it('転換が付いているつなぎ目には解除と「先に転換を解除」の案内を出す',()=>{
  const {view}=settings({transition:{kind:'crossfade',durationFrames:12}});
  expect(view.getByRole('button',{name:'この転換を解除'})).toBeTruthy();
  expect(view.getByText(/移動・分割は、先に転換を解除/)).toBeTruthy();
});

it('余白が無いつなぎ目は理由を出し、重なり 3 種だけを選べなくする',()=>{
  const {view}=settings({handles:{outHandle:0,inHandle:0}});
  expect(statusText(view)).toContain('使える元素材が足りない');
  expect(kindSelect(view).disabled).toBe(false);
  for(const value of ['crossfade','slide','wipe'])expect(option(view,value).disabled).toBe(true);
  for(const value of ['none','fadeBlack','fadeWhite','fadeColor'])expect(option(view,value).disabled).toBe(false);
});

it('速度を登録した案件では重なりを選べず、速度を戻す案内を出す',()=>{
  const {view}=settings({speedRegistered:true});
  expect(statusText(view)).toContain('速度を設定した案件では転換を付けられません。先に速度を全体へ戻してください');
  for(const value of ['crossfade','slide','wipe'])expect(option(view,value).disabled).toBe(true);
});

it('全つなぎ目適用は件数を出す（何も付いていない時は解除）',()=>{
  expect(settings({transition:{kind:'crossfade',durationFrames:12}}).view
    .getByRole('button',{name:/このトラックの全つなぎ目へ転換を適用（\d+件）/})).toBeTruthy();
  expect(settings().view.getByRole('button',{name:/このトラックの全つなぎ目の転換を解除（\d+件）/})).toBeTruthy();
});

it('場面フェードが付いているつなぎ目は現在値が暗転になり、置換になることを伝える',()=>{
  const {view}=settings({sceneFade:true});
  expect(kindSelect(view).value).toBe('fadeBlack');
  expect(statusText(view)).toContain('場面フェードが付いています');
});

it('重なりから色フェードへの切替は 1 コマンド（batch）で解除と付与を順に含む',async()=>{
  const {view,built}=settings({transition:{kind:'crossfade',durationFrames:12}});
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'fadeBlack'}});});
  expect(built).toHaveLength(1);
  const command=built[0]!;
  expect(command.type).toBe('batch');
  const commands=(command as Extract<SequenceCommand,{type:'batch'}>).commands;
  expect(commands.map(item=>item.type)).toEqual(['set-transition','set-scene-fades']);
  expect(commands[0]).toMatchObject({joinKey:TWO_CLIP_JOIN_KEY,transition:null});
});

it('色フェードから重なりへの切替は set-transition 1 本（排他はコマンド側）',async()=>{
  const {view,built}=settings({sceneFade:true});
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'crossfade'}});});
  expect(built.map(item=>item.type)).toEqual(['set-transition']);
  expect(built[0]).toMatchObject({joinKey:TWO_CLIP_JOIN_KEY});
});

it('組み立てたコマンドは planTransition の結果をそのまま渡す',async()=>{
  const {view,built,document}=settings();
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'crossfade'}});});
  const command=built[0] as Extract<SequenceCommand,{type:'set-transition'}>;
  expect(command.transition).toMatchObject({joinKey:TWO_CLIP_JOIN_KEY,joinFrame:150,trackId:'t1',outClipId:'c1',inClipId:'c2'});
  // 自前でフレームを計算しない＝コマンドを通しても全体尺が変わらない。
  expect(applySequenceCommand(document,command).sequenceEndFrame).toBe(document.sequenceEndFrame);
});

it('転換を付けた後もつなぎ目は一覧に残り、解除できる',async()=>{
  const {view,built}=settings({transition:{kind:'crossfade',durationFrames:12}});
  const joins=view.getByLabelText('転換のつなぎ目') as HTMLSelectElement;
  expect([...joins.options].map(item=>item.value)).toEqual([TWO_CLIP_JOIN_KEY]);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'この転換を解除'}));});
  expect(built).toEqual([{type:'set-transition',joinKey:TWO_CLIP_JOIN_KEY,transition:null}]);
});

it('全つなぎ目適用は 1 コマンドで全てのつなぎ目へ同じ転換を作る',async()=>{
  const {view,built,document}=settings({clips:3,transition:{kind:'crossfade',durationFrames:12}});
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'このトラックの全つなぎ目へ転換を適用（2件）'}));});
  expect(built).toHaveLength(1);
  const commands=(built[0] as Extract<SequenceCommand,{type:'batch'}>).commands;
  expect(commands.map(item=>item.type)).toEqual(['set-transition','set-transition']);
  // 後のつなぎ目の計画が古い状態で作られていないこと（batch が通り、全体尺は変わらない）。
  const applied=applySequenceCommand(document,built[0] as SequenceCommand);
  expect(applied.transitions).toHaveLength(2);
  expect(applied.sequenceEndFrame).toBe(document.sequenceEndFrame);
});

it('旧形式の転換は native から解除できないことを表示する',()=>{
  const {view}=settings({legacyTransition:true});
  expect(statusText(view)).toContain('以前の形式で保存された転換');
});

it('拒否された操作では文書が変わらない',async()=>{
  const document=twoClipDocument();
  const onEdit=vi.fn(async(build:(document:SequenceDocument)=>NativeCommand)=>{build(document);return false;});
  const view=render(<NativeTransitionSettings document={document} joinKey={TWO_CLIP_JOIN_KEY} disabled={false}
    onJoin={vi.fn(async()=>true)} onEdit={onEdit}/>);
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'crossfade'}});});
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(document.transitions).toEqual([]);
  expect(kindSelect(view).value).toBe('none');
});

it('場面フェード欄と転換欄は同じ状態を読み、どちらで変えても他方が追従する',async()=>{
  let document=twoClipDocument();
  const ref=createRef<NativeInspectorHandle>();
  const dispatch=async(command:NativeCommand)=>{
    if(command.type==='undo'||command.type==='redo')throw new Error('履歴は使わない');
    document=applySequenceCommand(document,command);view.rerender(element());return true;
  };
  const element=()=><NativeInspector ref={ref} projectId="test" document={document} readDocument={()=>document}
    frame={0} onSeek={()=>{}} selected={[]} disabled={false} bypassLut={false} onBypass={()=>{}}
    onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true} showSceneFades
    sceneFadeTarget={{kind:'join',trackId:'t1',outClipId:'c1',inClipId:'c2'}} onSceneFadeTargetChange={async()=>true}
    transitionJoinKey={TWO_CLIP_JOIN_KEY} onTransitionJoin={async()=>true}/>;
  const view=render(element());
  // 場面フェード欄で付けた単色フェードを、転換欄が現在値として読む。
  await act(async()=>{fireEvent.change(view.getByLabelText('フェードの種類'),{target:{value:'fadeWhite'}});});
  expect((view.getByLabelText('転換の種類') as HTMLSelectElement).value).toBe('fadeWhite');
  // 転換欄で重なりへ替えると、排他により場面フェードが消えて場面フェード欄も追従する。
  await act(async()=>{fireEvent.change(view.getByLabelText('転換の種類'),{target:{value:'crossfade'}});});
  expect(document.clips.some(clip=>clip.content.kind==='scene-fade')).toBe(false);
  expect(document.transitions).toHaveLength(1);
  expect((view.getByLabelText('転換の種類') as HTMLSelectElement).value).toBe('crossfade');
  // 重なった境界は場面フェードの対象として解決できなくなる（既存の場面フェード欄の挙動）。
  expect(view.getByRole('alert').textContent).toContain('映像のつなぎ目が変わりました');
});

it('90fr の暗転が付いた join で色だけ変更しても長さが縮まない（I1）',()=>{
  let document=twoClipDocument();
  document=applySequenceCommand(document,{type:'set-scene-fades',
    targets:[{kind:'join',trackId:'t1',outClipId:'c1',inClipId:'c2'}],change:{enabled:true,color:'#000000',durationFrames:90}});
  const built:NativeCommand[]=[];
  const onEdit=vi.fn(async(build:(document:SequenceDocument)=>NativeCommand)=>{built.push(build(document));return true;});
  const view=render(<NativeTransitionSettings document={document} joinKey={TWO_CLIP_JOIN_KEY} disabled={false}
    onJoin={vi.fn(async()=>true)} onEdit={onEdit}/>);
  expect((view.getByLabelText('転換の長さ（fr）') as HTMLInputElement).value).toBe('90');
  expect((view.getByLabelText('転換の長さ（fr）') as HTMLInputElement).max).toBe('');
  fireEvent.change(kindSelect(view),{target:{value:'fadeColor'}});
  const command=built[0] as Extract<SequenceCommand,{type:'set-scene-fades'}>;
  expect(command.change).toMatchObject({durationFrames:90});
});

it('apply が reject すると種類欄は文書の値へ戻る（M4）',async()=>{
  const document=twoClipDocument();
  const onEdit=vi.fn(async()=>{throw new Error('保存に失敗しました');});
  const view=render(<NativeTransitionSettings document={document} joinKey={TWO_CLIP_JOIN_KEY} disabled={false}
    onJoin={vi.fn(async()=>true)} onEdit={onEdit}/>);
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'crossfade'}});});
  expect(kindSelect(view).value).toBe('none');
});

it('全つなぎ目適用は余白不足のつなぎ目を除外し、残りだけを含める（I3）',async()=>{
  const document=threeClipDocument({c1Tail:0,c2Head:0,c2Tail:20,c3Head:20});
  const built:NativeCommand[]=[];
  const onEdit=vi.fn(async(build:(document:SequenceDocument)=>NativeCommand)=>{built.push(build(document));return true;});
  const view=render(<NativeTransitionSettings document={document} joinKey={JOIN_2} disabled={false}
    onJoin={vi.fn(async()=>true)} onEdit={onEdit}/>);
  await act(async()=>{fireEvent.change(kindSelect(view),{target:{value:'crossfade'}});});
  built.length=0;
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:/このトラックの全つなぎ目へ転換を適用/}));});
  expect(built).toHaveLength(1);
  const command=built[0]!;
  const commands=command.type==='batch'?command.commands:[command];
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({type:'set-transition',joinKey:JOIN_2});
  expect(commands.some(item=>'joinKey' in item&&item.joinKey===JOIN_1)).toBe(false);
});

it('全滅（適用できるつなぎ目が無い）なら一括適用は明示エラーで拒否し、黙って 0 件成功しない（I3）',async()=>{
  // 何も付いていない状態で「全つなぎ目を解除」を押す＝除ける対象がどのつなぎ目にも無い、という全滅ケース。
  const document=twoClipDocument();
  const onEdit=vi.fn(async(build:(document:SequenceDocument)=>NativeCommand)=>{build(document);return true;});
  const view=render(<NativeTransitionSettings document={document} joinKey={TWO_CLIP_JOIN_KEY} disabled={false}
    onJoin={vi.fn(async()=>true)} onEdit={onEdit}/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:/このトラックの全つなぎ目の転換を解除/}));});
  expect(onEdit).toHaveBeenCalledTimes(1);
  const build=onEdit.mock.calls[0]![0] as (document:SequenceDocument)=>NativeCommand;
  expect(()=>build(document)).toThrow('解除できるつなぎ目がありません。');
});
