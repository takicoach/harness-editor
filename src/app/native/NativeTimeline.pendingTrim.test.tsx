/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {NativeTimeline,RIPPLE_NOTICE,TRIM_FAILED_NOTICE} from './NativeTimeline';
import {applySequenceCommand} from '../../core/sequence/commands';
import {fixture} from '../../core/sequence/fixtures';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
vi.mock('./NativeFilmstrip',()=>({NativeFilmstrip:()=>null}));
vi.mock('./NativeWaveform',()=>({NativeWaveform:()=>null}));
vi.mock('../eventBus',()=>({useEventChannel:()=>{}}));
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
type Props=ComponentProps<typeof NativeTimeline>;
const split=()=>applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
function setup(extra:Partial<Props>={}){
  let finish!:(ok:boolean)=>void;
  let props:Props={projectId:'p',sessionId:'s1',document:split(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,ripple:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(()=>new Promise<boolean>(done=>{finish=done;})),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,get props(){return props;},
    clip:(end:number)=>ui.getByRole('button',{name:new RegExp(`^映像 0〜${end}フレーム`)}),
    handle:(edge:'start'|'end')=>ui.getAllByRole('button',{name:edge==='end'?/映像の終了位置を調整/:/映像の開始位置を調整/})[0]!,
    finish:(ok:boolean)=>act(async()=>{finish(ok);}),
    update(next:Partial<Props>){props={...props,...next};ui.rerender(<NativeTimeline {...props}/>);}};
}
const drag=async(node:Element,from:number,to:number)=>{
  fireEvent.pointerDown(node,{button:0,buttons:1,pointerId:1,clientX:from,clientY:60});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:to,clientY:60});
  await act(async()=>{fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:to,clientY:60});});
};
it('keeps the trimmed width after release instead of snapping back, until the confirmed document arrives',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);
  expect(t.clip(150).style.width).toBe('120px');expect(t.clip(150).getAttribute('data-native-settling')).toBe('true');
  t.update({document:applySequenceCommand(t.props.document,{type:'trim',clipId:t.clip(150).getAttribute('data-native-clip-id')!,edge:'end',frame:120})});
  expect(t.clip(120).style.width).toBe('120px');   // 確定文書の採用と確定待ちの解除が同じ更新（差分を二重に足さない）
  await t.finish(true);expect(t.clip(120).style.width).toBe('120px');expect(t.clip(120).hasAttribute('data-native-settling')).toBe(false);
});
it('returns to the original width with a reason when the trim fails',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);await t.finish(false);
  expect(t.clip(150).style.width).toBe('150px');expect(t.ui.container.textContent).toContain(TRIM_FAILED_NOTICE);
});
it('returns to the original width when the server made no change',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);await t.finish(true);expect(t.clip(150).style.width).toBe('150px');
});
it('drops the pending width when another session (an external reload) replaces the document',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);t.update({sessionId:'s2'});expect(t.clip(150).style.width).toBe('150px');
});
it('ripple close on the start edge: the clip keeps its place and shrinks, as it will after the commit',async()=>{
  const t=setup({ripple:true});await drag(t.handle('start'),132,162);
  expect(t.clip(150).style.left).toBe('132px');expect(t.clip(150).style.width).toBe('120px');
});
it('the same document id and revision from another session (a live reload) never wears the old pending geometry',async()=>{
  // 再読込の文書は同じ id・同じ版・同じクリップ id（video）のまま、中身（長さ 100）が違う。
  const t=setup();await drag(t.handle('end'),282,252);
  const reloaded=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:100});
  expect([reloaded.id,reloaded.revision]).toEqual([t.props.document.id,t.props.document.revision]);
  t.update({sessionId:'s2',document:reloaded});
  expect(t.clip(100).style.width).toBe('100px');expect(t.clip(100).hasAttribute('data-native-settling')).toBe(false);
  await t.finish(true);expect(t.clip(100).style.width).toBe('100px');
});
it('an external or AI edit that lands while the trim is pending drops the pending width at once; the late failure does not bring it back',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);
  t.update({document:{...t.props.document,revision:t.props.document.revision+1}});
  expect(t.clip(150).style.width).toBe('150px');expect(t.clip(150).hasAttribute('data-native-settling')).toBe(false);
  await t.finish(false);
  expect(t.clip(150).style.width).toBe('150px');expect(t.ui.getByRole('status').textContent).toBe(TRIM_FAILED_NOTICE);
});
it('a failure replaces the "moved only the edge" explanation instead of leaving it beside the restored width',async()=>{
  const registered=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'g1',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  const t=setup({ripple:true,document:registered});await drag(t.handle('end'),282,232);
  expect(t.ui.getByRole('status').textContent).toBe(RIPPLE_NOTICE.speed);expect(t.clip(300).style.width).toBe('250px');
  await t.finish(false);
  expect(t.clip(300).style.width).toBe('300px');expect(t.ui.getByRole('status').textContent).toBe(TRIM_FAILED_NOTICE);
});
it('keeps the reason the command itself gave when it throws',async()=>{
  const t=setup({onCommand:vi.fn(async()=>{throw new Error('保存先に書けません');})});await drag(t.handle('end'),282,252);
  expect(t.clip(150).style.width).toBe('150px');expect(t.ui.getByRole('status').textContent).toBe('保存先に書けません');
});
it('while the trim settles the timeline takes no other edit: a second trim drag, a range drag and an arrow-key trim send nothing',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);
  await drag(t.handle('end'),252,222);
  await act(async()=>{fireEvent.keyDown(t.handle('end'),{key:'ArrowLeft'});});
  t.update({tool:'range'});
  const row=t.ui.container.querySelector('[data-native-track="v1"]')!;await drag(row,400,500);
  expect(t.props.onCommand).toHaveBeenCalledTimes(1);expect(t.props.onRange).not.toHaveBeenCalledWith(expect.objectContaining({startFrame:expect.any(Number)}));
  expect(t.clip(150).style.width).toBe('120px');expect(t.clip(150).getAttribute('data-native-settling')).toBe('true');
  // 確定後は次の操作を受ける。
  t.update({tool:'select',document:applySequenceCommand(t.props.document,{type:'trim',clipId:'video',edge:'end',frame:120})});await t.finish(true);
  await drag(t.handle('end'),252,222);expect(t.props.onCommand).toHaveBeenCalledTimes(2);expect(t.clip(120).style.width).toBe('90px');
});
it('a drag that spans a session change is dropped, not committed onto the new session\'s content',async()=>{
  const t=setup();
  fireEvent.pointerDown(t.handle('end'),{button:0,buttons:1,pointerId:1,clientX:282,clientY:60});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:252,clientY:60});
  t.update({sessionId:'s2'});
  await act(async()=>{fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:252,clientY:60});});
  expect(t.props.onCommand).not.toHaveBeenCalled();expect(t.clip(150).style.width).toBe('150px');expect(t.clip(150).hasAttribute('data-native-settling')).toBe(false);
});
it('finish: the settled clip is drawn at its committed width as well',async()=>{
  const t=setup({mode:'finish'});await drag(t.handle('end'),282,252);
  expect(t.clip(150).style.width).toBe('120px');expect(t.clip(150).getAttribute('data-native-settling')).toBe('true');
  await t.finish(false);expect(t.clip(150).style.width).toBe('150px');
});

it('ripple close: the band explaining the gap stays while settling and goes with the confirmed document',async()=>{
  const t=setup({ripple:true});await drag(t.handle('end'),282,252);
  const band=()=>t.ui.container.querySelector<HTMLElement>('.native-ripple-ghost-close');
  expect(t.clip(150).style.width).toBe('120px');expect(band()).not.toBeNull();expect(band()!.style.left).toBe('252px');
  t.update({document:applySequenceCommand(t.props.document,{type:'trim',clipId:'video',edge:'end',frame:120,ripple:true})});
  expect(band()).toBeNull();await t.finish(true);expect(band()).toBeNull();
});
it('join: the extended clip comes to the front with its "1 本に戻す" label until the answer; a failure takes both away',async()=>{
  const t=setup({ripple:true});await drag(t.handle('end'),282,332);
  const label=()=>t.ui.container.querySelector('.native-ripple-ghost-join'),right=()=>t.ui.getByRole('button',{name:/^映像 150〜300フレーム/});
  expect(t.clip(150).style.width).toBe('200px');expect(label()?.textContent).toBe('1 本に戻す');
  // 右隣より後ろに並ぶ部品なので、前面に出さないと延長した部分が右隣の下に隠れて元の幅に見える。
  expect(t.clip(150).style.zIndex).toBe('3');expect(right().style.zIndex).toBe('');
  await t.finish(false);
  expect(label()).toBeNull();expect(t.clip(150).style.zIndex).toBe('');expect(t.clip(150).style.width).toBe('150px');expect(t.ui.getByRole('status').textContent).toBe(TRIM_FAILED_NOTICE);
});
it('join that also pushes: both bands stay while settling and go with the confirmed document',async()=>{
  const t=setup({ripple:true});await drag(t.handle('end'),282,452);
  const bands=()=>[...t.ui.container.querySelectorAll('.native-ripple-ghost-join,.native-ripple-ghost-push')].map(node=>node.className);
  expect(bands()).toEqual(['native-ripple-ghost-push','native-ripple-ghost-join']);
  t.update({document:applySequenceCommand(t.props.document,{type:'trim',clipId:'video',edge:'end',frame:320,ripple:true})});
  expect(bands()).toEqual([]);expect(t.clip(320).style.width).toBe('320px');expect(t.clip(320).style.zIndex).toBe('');
});
it('start-edge join pulled past the left neighbour: the settled clip starts where the commit lands, so nothing jumps',async()=>{
  const once=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:100});
  const three=applySequenceCommand(once,{type:'split',clipIds:[once.clips.find(c=>c.trackId==='v1'&&c.startFrame===100)!.id],frame:200});
  const t=setup({ripple:true,document:three}),third=three.clips.find(c=>c.trackId==='v1'&&c.startFrame===200)!;
  await drag(t.ui.container.querySelector(`[data-native-clip-id="${third.id}"] .native-trim-start`)!,332,182);
  const settled=t.ui.getByRole('button',{name:/^映像 200〜300フレーム/});
  expect([settled.style.left,settled.style.width]).toEqual(['232px','200px']);
  t.update({document:applySequenceCommand(three,{type:'trim',clipId:third.id,edge:'start',frame:50,ripple:true})});
  const joined=t.ui.getByRole('button',{name:/^映像 100〜300フレーム/});expect([joined.style.left,joined.style.width]).toEqual(['232px','200px']);
});
it('a failure that arrives after the view changed (mode) does not tell the new view that its trim failed',async()=>{
  const t=setup();await drag(t.handle('end'),282,252);
  t.update({mode:'finish'});await t.finish(false);
  expect(t.clip(150).style.width).toBe('150px');expect(t.ui.getByRole('status').textContent).toBe('');
});

/** 本物の useNativeSession（/command の応答・409）を通す。 */
function sessionSetup(){
  const start:NativeSession={sessionId:'one',document:split(),savedRevision:0,savedContentHash:'h',dirty:false,canUndo:false,canRedo:false};
  let answer!:(response:{ok:boolean;status:number;body:unknown})=>void;const commands:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.includes('/command')){commands.push(JSON.parse(String(init!.body)));const r=await new Promise<{ok:boolean;status:number;body:unknown}>(done=>{answer=done;});return {ok:r.ok,status:r.status,json:async()=>r.body};}
    if(url.includes('/session/status'))return {ok:true,status:200,json:async()=>({unchanged:true,sessionId:'one'})};
    if(url.includes('/session'))return {ok:true,status:200,json:async()=>start};
    return {ok:true,status:200,json:async()=>({document:start.document})};
  }));
  function Host(){
    const session=useNativeSession('p');
    return session.state?<NativeTimeline projectId="p" sessionId={session.state.sessionId} document={session.state.document} busy={session.busy} onCommand={session.execute}
      waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false} ripple={false} onSelect={()=>{}} onRange={()=>{}} onSeek={()=>{}} onDrop={()=>{}}/>:null;
  }
  const ui=render(<Host/>);
  return {ui,start,commands,answer:(response:{ok:boolean;status:number;body:unknown})=>act(async()=>{answer(response);}),
    async ready(){const scroller=await waitFor(()=>ui.getByLabelText('タイムライン'));
      scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});},
    clip:(end:number)=>ui.getByRole('button',{name:new RegExp(`^映像 0〜${end}フレーム`)}),
    handle:()=>ui.getAllByRole('button',{name:/映像の終了位置を調整/})[0]!};
}
it('session: from release to the confirmed answer the clip never shows its original width (every style change is recorded)',async()=>{
  const h=sessionSetup();await h.ready();
  const node=h.clip(150),widths:string[]=[],observer=new MutationObserver(records=>{for(const record of records)widths.push(record.oldValue??'');});
  observer.observe(node,{attributes:true,attributeFilter:['style'],attributeOldValue:true});
  await drag(h.handle(),282,252);expect(h.commands).toEqual([{sessionId:'one',expectedRevision:1,executionId:expect.any(String),command:{type:'trim',clipId:'video',edge:'end',frame:120}}]);
  await h.answer({ok:true,status:200,body:{...h.start,document:applySequenceCommand(h.start.document,{type:'trim',clipId:'video',edge:'end',frame:120}),dirty:true}});
  await act(async()=>{await Promise.resolve();});observer.disconnect();
  // 同じ要素（クリップ id が鍵）で、ドラッグの影 → 確定待ち → 確定の順に変わる。元の幅（150px）は最初の1回だけ。
  expect(h.clip(120)).toBe(node);expect(node.style.width).toBe('120px');expect(node.hasAttribute('data-native-settling')).toBe(false);
  const seen=[...widths.map(style=>/width: ([\d.]+px)/.exec(style)?.[1]),node.style.width];
  expect(seen[0]).toBe('150px');expect(seen.slice(1).length).toBeGreaterThan(0);expect(seen.slice(1).every(width=>width==='120px')).toBe(true);
});
it('session: a revision conflict (409) restores the original width with the reason',async()=>{
  const h=sessionSetup();await h.ready();
  await drag(h.handle(),282,252);expect(h.clip(150).style.width).toBe('120px');
  await h.answer({ok:false,status:409,body:{error:'ほかの編集が先に入りました',code:'REVISION_CONFLICT'}});
  await waitFor(()=>expect(h.clip(150).style.width).toBe('150px'));
  expect(h.clip(150).hasAttribute('data-native-settling')).toBe(false);expect(h.ui.getByRole('status').textContent).toBe(TRIM_FAILED_NOTICE);
});
