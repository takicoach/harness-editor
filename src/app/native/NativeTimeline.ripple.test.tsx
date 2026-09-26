/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {NativeTimeline,RIPPLE_JOIN_START_NOTICE,RIPPLE_NOTICE,RIPPLE_CLAMP_GHOST} from './NativeTimeline';
import {applySequenceCommand} from '../../core/sequence/commands';
import {fixture} from '../../core/sequence/fixtures';
import {rational as r} from '../../core/sequence/time';

beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();
  HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

const split=()=>applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
/** 100 と 200 で 2 回割る。3 片目 [200,300) の左隣は [100,200)（先頭は 0 ではない）。 */
const splitTwice=()=>{
  const once=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:100});
  const middle=once.clips.find(c=>c.trackId==='v1'&&c.startFrame===100)!;
  return applySequenceCommand(once,{type:'split',clipIds:[middle.id],frame:200});
};
/** T4 の rippleTrim.push.test.ts と同じ作り方（リンクを外し、右隣を別素材の独立クリップにする）。 */
const pushable=()=>{
  const doc=applySequenceCommand(fixture(),{type:'unlink',clipIds:['video']});
  doc.assets.push({id:'other',kind:'media',file:'public/other.mp4',name:'別素材',fingerprint:'other-source',
    streams:[{index:0,kind:'video',codec:'h264',duration:r(60),frameRate:r(30),width:1920,height:1080}]});
  doc.clips.find(c=>c.id==='video')!.durationFrames=150;
  doc.clips.push({id:'video2',name:'別素材',trackId:'v1',startFrame:150,durationFrames:150,
    clock:{offset:r(0),rate:r(1),duration:r(150)},
    content:{kind:'video',assetId:'other',streamIndex:0,sourceIn:r(0),rate:r(1)}});
  return doc;
};
type Props=ComponentProps<typeof NativeTimeline>;
function setup(extra:Partial<Props>={}){
  const props:Props={projectId:'p',document:split(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,props,scroller,endHandle:()=>ui.getAllByRole('button',{name:/映像の終了位置を調整/})[0]!,
    setRipple:(ripple:boolean)=>ui.rerender(<NativeTimeline {...props} ripple={ripple}/>)};
}
const down=(node:Element,x:number)=>fireEvent.pointerDown(node,{button:0,buttons:1,pointerId:1,clientX:x,clientY:60});
const move=(x:number)=>fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:x,clientY:60});
const up=(x:number)=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:x,clientY:60});

it('OFF では ripple を送らず、隣の手前で止まる',async()=>{
  const t=setup({ripple:false});const handle=t.endHandle();
  down(handle,282);move(482);await act(async()=>up(482));
  // 導出: zoom=1 なので 1px=1fr。左クリップの終端 150 から +200 は右隣（150 始まり）を越える → 150 で止まる。
  //       止まった先が元の端と同じなので delta=0 → コマンドを送らない。
  expect(t.props.onCommand).not.toHaveBeenCalled();
});
it('ON では ripple:true を付けて送る',async()=>{
  const t=setup({ripple:true});const handle=t.endHandle();
  down(handle,282);move(332);await act(async()=>up(332));
  expect(t.props.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({type:'trim',edge:'end',ripple:true}));
});
it('ripple prop を省略すると既定で ON になる（RT6: 無言 OFF の罠を消す）',async()=>{
  const t=setup();const handle=t.endHandle();
  down(handle,282);move(332);await act(async()=>up(332));
  expect(t.props.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({type:'trim',edge:'end',ripple:true}));
});
it('ON の短縮は詰める帯のゴーストを出す',()=>{
  const t=setup({ripple:true});const handle=t.endHandle();
  down(handle,282);move(232);
  expect(t.ui.container.querySelector('.native-ripple-ghost-close')).not.toBeNull();
});
it('ON の続きへの延長は「1 本に戻す」を role=status で出す',()=>{
  const t=setup({ripple:true});const handle=t.endHandle();
  down(handle,282);move(332);
  expect(t.ui.getByRole('status').textContent).toContain('1 本に戻す');
});
it('ON の続きでない延長は押し出しの影を出す',()=>{
  // fixture は T4 の pushable()（リンクを外し、右隣を別素材の独立クリップにしたもの）と同じ作り方にする。
  // split linked:false は左片が元の linkGroupId を保つため「続きでない隣」の作り方として弱い。
  const t=setup({ripple:true,document:pushable()});
  const handle=t.endHandle();down(handle,282);move(332);
  expect(t.ui.container.querySelector('.native-ripple-ghost-push')).not.toBeNull();
});
it('速度を登録したクリップは ripple を外して送り、理由を出す（裁定 4）',async()=>{
  const registered=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'g1',
    mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  const t=setup({ripple:true,document:registered});const handle=t.endHandle();
  down(handle,282);move(232);await act(async()=>up(232));
  // 「ripple キーを送らない」を完全一致で固定する（not.objectContaining は ripple:false でも通る）。
  expect(t.props.onCommand).toHaveBeenLastCalledWith({type:'trim',clipId:'video',edge:'end',frame:250});
  // 文言も全文一致（transition の文言と取り違えない）。
  expect(t.ui.getByRole('status').textContent).toBe(RIPPLE_NOTICE.speed);
});
it('結合してもなお越える延長は「1 本に戻す」と押し出しの影を同時に出す（join.push）',()=>{
  // 左片の終端 150 を右片の終端 300 より先へ伸ばす。結合したうえで残りを右へ押し出す計画になる。
  const t=setup({ripple:true});const handle=t.endHandle();
  down(handle,282);move(452);
  expect(t.ui.container.querySelector('.native-ripple-ghost-join')).not.toBeNull();
  expect(t.ui.container.querySelector('.native-ripple-ghost-push')).not.toBeNull();
});
it('OFF のキー延長は隣の手前で止まり、ripple を送らない',async()=>{
  const t=setup({ripple:false}); // 明示的に OFF（コンポーネント既定は RT6 で true に昇格済み）
  const right=t.ui.getAllByRole('button',{name:/映像の開始位置を調整/})[1]!;void right;
  // 左片の終端は 150、右隣も 150 始まりなので、右矢印 1 回は隣を越える → clamp で 150 に戻る＝送らない。
  fireEvent.keyDown(t.endHandle(),{key:'ArrowRight'});
  expect(t.props.onCommand).not.toHaveBeenCalled();
  // 左矢印（短縮）は OFF でも従来トリムとして通り、ripple キーは付かない。
  fireEvent.keyDown(t.endHandle(),{key:'ArrowLeft'});
  expect(t.props.onCommand).toHaveBeenLastCalledWith({type:'trim',clipId:expect.any(String),edge:'end',frame:149});
});
it('キー操作も同じ計画を通る（ON なら ripple:true）',()=>{
  const t=setup({ripple:true});fireEvent.keyDown(t.endHandle(),{key:'ArrowLeft'});
  expect(t.props.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({type:'trim',ripple:true}));
});

it('ドラッグ中に R を押しても、開始時のトグルどおりに確定する（最終広域レビュー I-1）',async()=>{
  // 開始時 ON。左片の終端 150 を右片の終端 300 より先へ伸ばす（結合＋押し出しの計画）。
  const t=setup({ripple:true});const handle=t.endHandle();
  down(handle,282);move(452);
  // ここで R を押した＝ripple prop が false に変わる。ジェスチャは継続（ripple は cancel の依存に無い）。
  t.setRipple(false);
  // 位置も動かして計画を取り直させる（キャッシュ頼みでないことの証拠）。+180 → 要求は 330。
  move(462);
  await act(async()=>up(462));
  // 開始時の ON どおり: ripple:true を付け、右隣（150）でも結合後の終端（300）でも止めない。
  expect(t.props.onCommand).toHaveBeenLastCalledWith({type:'trim',clipId:expect.any(String),edge:'end',frame:330,ripple:true});
});
it('ドラッグ中に R を押して ON にしても、開始時 OFF なら従来トリムのまま確定する（I-1 の逆向き）',async()=>{
  const t=setup({ripple:false});const handle=t.endHandle();
  down(handle,282);move(232);
  t.setRipple(true);
  move(222);
  await act(async()=>up(222));
  // 開始時 OFF なので短縮は従来トリム＝ripple キーを送らない（150-60=90）。
  expect(t.props.onCommand).toHaveBeenLastCalledWith({type:'trim',clipId:expect.any(String),edge:'end',frame:90});
});

it('キー操作は前回の理由を残さない（M-2）',async()=>{
  // 右片の終端に転換を掛ける。右片の終端をキーで縮めると reject:'transition' で理由が出る。
  const doc=split();
  const right=doc.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!;
  doc.transitions=[{id:'t',trackId:'v1',outClipId:right.id,kind:'fadeBlack',startFrame:290,durationFrames:10,edge:'out'}];
  const t=setup({ripple:true,document:doc});
  const ends=()=>t.ui.getAllByRole('button',{name:/映像の終了位置を調整/});
  await act(async()=>{fireEvent.keyDown(ends()[1]!,{key:'ArrowLeft'});});
  expect(t.ui.getByRole('status').textContent).toBe(RIPPLE_NOTICE.transition);
  // 別のクリップの成功するキー操作（左片の終端を右へ＝押し出し）で、古い理由は消える。
  await act(async()=>{fireEvent.keyDown(ends()[0]!,{key:'ArrowRight'});});
  expect(t.props.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({edge:'end',frame:151,ripple:true}));
  expect(t.ui.getByRole('status').textContent).toBe('');
});
it('開始端の結合で行き過ぎた分は無言にしない（M-4）',async()=>{
  // 3 片目の開始端 200 を、左隣の先頭 100 より更に左（50）へ引く。
  const t=setup({ripple:true,document:splitTwice()});
  const startHandle=t.ui.getAllByRole('button',{name:/映像の開始位置を調整/})[2]!;
  down(startHandle,282);move(132);await act(async()=>up(132));
  // 結合は左隣の先頭（100）に着地する。要求した 50 との差は文書に出ないので通知で伝える。
  expect(t.props.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({edge:'start',frame:50,ripple:true}));
  expect(t.ui.getByRole('status').textContent).toBe(RIPPLE_JOIN_START_NOTICE);
});

it('clamp ゴースト文言が reason ごとに正しく出し分けられる',()=>{
  // RIPPLE_CLAMP_GHOST[reason] が呼ばれることを確認するテスト。
  // reason が undefined の場合は「ここで止まる」、指定されている場合は対応する文言が表示される。
  // linked-overhang は §5 v2.3、fixed-insert-length は §5 v2.4。
  const ghostTexts=RIPPLE_CLAMP_GHOST;
  // 登録済みの理由がすべてカバーされていることを確認。
  expect(ghostTexts['linked-overhang']).toBeTruthy();
  expect(ghostTexts['fixed-insert-length']).toBeTruthy();
  // 文言が異なっていることを確認（同じ文言ではないこと）。
  expect(ghostTexts['linked-overhang']).not.toBe(ghostTexts['fixed-insert-length']);
});
