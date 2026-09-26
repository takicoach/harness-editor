/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeCaptionPanel,type NativeCaptionHandle} from './NativeCaptionPanel';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
import type {NativeSession,NativeCommand} from './api';
import type {CutArchiveEntry} from '../../core/sequence/model';
import {archivedWords} from './cutPresentation';
import * as wordChips from './wordChips';

/** A real archive entry: one archived speech clip whose transcript actually yields words,
 * so `isCaptionCut`'s archive-matching branch (not just the durationFrames:0 early return) is exercised. */
function cutEntry(id:string,startFrame:number,durationFrames:number):CutArchiveEntry{
  return {id,durationFrames,completionFloorFrames:durationFrames,origin:{cutId:id,startFrame:0,endFrame:durationFrames},
    boundary:{hintFrame:0,ambiguous:true,references:[]},
    tracks:[{id:'a',kind:'audio',name:'音声',enabled:true}],
    clips:[{id:id+'-audio',name:'原音',trackId:'a',startFrame,durationFrames,clock:{offset:r(0),rate:r(1),duration:r(durationFrames)},
      content:{kind:'audio',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,
        settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
}

afterEach(cleanup);
function setup(){
  let state:NativeSession={sessionId:'session-a',savedRevision:0,savedContentHash:'hash',canUndo:false,canRedo:false,dirty:false,document:{schemaVersion:2,id:'project',name:'字幕',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:240,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[],transcripts:[],transitions:[],tracks:[{id:'t',kind:'visual',name:'字幕',enabled:true}],clips:[
    {id:'one',name:'前半の字幕',trackId:'t',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'前半の字幕'}}},
    {id:'two',name:'後半の字幕',trackId:'t',startFrame:120,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'後半の字幕'}}},
  ]}};
  const ref=createRef<NativeCaptionHandle>();
  const execute=vi.fn(async(command:NativeCommand)=>{
    if(command.type==='undo'||command.type==='redo')return false;
    state={...state,document:applySequenceCommand(state.document,command)};refresh();return true;
  });
  const props={projectId:'project',state,busy:false,switching:false,frame:60,playing:false,selected:[] as string[],read:()=>state,prepare:vi.fn(async()=>true),execute,onCollapse:vi.fn(),onDraft:vi.fn(),onSelect:vi.fn(),onStyle:vi.fn()};
  const element=()=> <div className="native-right-content"><div className="native-transcript"><select aria-label="発話の使用箇所"><option>原音</option></select></div><NativeCaptionPanel ref={ref} {...props}/></div>;
  const view=render(element());
  function refresh(){props.state=state;view.rerender(element());}
  return {ref,view,props,execute,refresh,get state(){return state;},replace(next:NativeSession){state=next;refresh();}};
}
function open(h:ReturnType<typeof setup>,id:string){h.props.selected=[id];h.refresh();return h.view.getByLabelText('字幕本文 '+id);}
it('pauses caption following for wheel input anywhere in the shared scroll pane',()=>{
  const previous=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView'),scroll=vi.fn();
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});
  const now=vi.spyOn(Date,'now').mockReturnValue(10000);
  try{
    const h=setup();h.props.playing=true;h.refresh();expect(scroll).toHaveBeenCalledTimes(1);scroll.mockClear();
    fireEvent.wheel(h.view.getByLabelText('発話の使用箇所'),{deltaY:-2400});
    h.props.frame=121;h.refresh();expect(scroll).not.toHaveBeenCalled();
    now.mockReturnValue(14001);h.props.frame=122;h.refresh();expect(scroll).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  }finally{now.mockRestore();if(previous)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',previous);else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');}
});
it('keeps edits to multiple rows and flushes them as one undoable batch',async()=>{
  const h=setup();fireEvent.change(open(h,'one'),{target:{value:'変更した前半'}});fireEvent.change(open(h,'two'),{target:{value:'変更した後半'}});
  expect(h.props.onDraft).toHaveBeenLastCalledWith(true);
  await act(async()=>expect(await h.ref.current!.flush()).toBe(true));
  expect(h.execute).toHaveBeenCalledTimes(1);expect(h.execute.mock.calls[0]![0].type).toBe('batch');
  expect(h.state.document.clips.map(c=>c.name)).toEqual(['変更した前半','変更した後半']);expect(h.props.onDraft).toHaveBeenLastCalledWith(false);
});
it('retains the text on failed save and retries without navigation or silent loss',async()=>{
  const h=setup();h.execute.mockResolvedValueOnce(false);
  fireEvent.change(open(h,'one'),{target:{value:'保存前の入力'}});
  await act(async()=>expect(await h.ref.current!.flush()).toBe(false));
  expect((h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement).value).toBe('保存前の入力');
  expect(h.view.getByRole('alert').textContent).toContain('入力');
  await act(async()=>expect(await h.ref.current!.flush()).toBe(true));expect(h.state.document.clips[0]!.name).toBe('保存前の入力');
});
it('blocks conflicting remote text until the user explicitly chooses their draft',async()=>{
  const h=setup();fireEvent.change(open(h,'one'),{target:{value:'人が書いた本文'}});
  const doc=structuredClone(h.state.document);doc.revision++;const clip=doc.clips[0]!;if(clip.content.kind==='telop')clip.content.data.text='AIが変えた本文';
  h.replace({...h.state,document:doc});
  await act(async()=>expect(await h.ref.current!.flush()).toBe(false));expect(h.execute).not.toHaveBeenCalled();
  fireEvent.click(h.view.getByText('入力した本文を使う'));
  await act(async()=>expect(await h.ref.current!.flush()).toBe(true));expect(h.state.document.clips[0]!.name).toBe('人が書いた本文');
});
it('preserves a later keystroke while an earlier acknowledgement is in flight',async()=>{
  const h=setup();let release!:()=>void;const deferred=new Promise<void>(resolve=>{release=resolve;});
  const apply=h.execute.getMockImplementation()!;h.execute.mockImplementationOnce(async command=>{await deferred;return apply(command);});
  fireEvent.change(open(h,'one'),{target:{value:'一回目'}});
  let result!:Promise<boolean>;act(()=>{result=h.ref.current!.flush();});await waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(1));
  fireEvent.change(h.view.getByLabelText('字幕本文 one'),{target:{value:'二回目'}});
  await act(async()=>{release();expect(await result).toBe(true);});
  expect(h.state.document.clips[0]!.name).toBe('二回目');expect(h.execute).toHaveBeenCalledTimes(2);
});
it('splits and selects the right fragment, then merges through the actual core',async()=>{
  const h=setup();h.props.selected=['one'];h.refresh();
  fireEvent.click(h.view.getAllByText('再生位置で分割')[0]!);
  await waitFor(()=>expect(h.props.onSelect).toHaveBeenCalled());
  const right=h.state.document.clips.find(c=>c.startFrame===60)!;expect(h.props.onSelect).toHaveBeenLastCalledWith(right.id,60);
  expect(h.state.document.clips.map(c=>c.durationFrames)).toEqual([60,60,120]);
  h.props.selected=['one'];h.refresh();
  fireEvent.click(h.view.getAllByText('次と結合')[0]!);
  await waitFor(()=>expect(h.state.document.clips).toHaveLength(2));expect(h.state.document.clips[0]!.name).toBe('前半の字幕');
});
it('keeps the draft visible when its caption disappears and prevents closing it silently',async()=>{
  const h=setup();fireEvent.change(open(h,'one'),{target:{value:'消さない文章'}});
  h.replace({...h.state,document:{...h.state.document,revision:1,clips:h.state.document.clips.slice(1)}});
  await act(async()=>expect(await h.ref.current!.flush()).toBe(false));expect(h.view.getByLabelText('未反映の字幕本文')).toHaveProperty('value','消さない文章');
  const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
});
it('does not apply an old session acknowledgement to a reopened project draft',async()=>{
  const h=setup();let release!:(ok:boolean)=>void;h.execute.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  fireEvent.change(open(h,'one'),{target:{value:'再接続前の入力'}});
  let result!:Promise<boolean>;act(()=>{result=h.ref.current!.flush();});await waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(1));
  h.replace({...h.state,sessionId:'session-b'});
  await act(async()=>{release(true);expect(await result).toBe(false);});
  expect(h.view.getByLabelText('字幕本文 one')).toHaveProperty('value','再接続前の入力');expect(h.props.onDraft).toHaveBeenLastCalledWith(true);
});
it('flushes more than 50 edited rows within the API limit and retains the failed remainder',async()=>{
  const h=setup(),template=h.state.document.clips[0]!;
  h.replace({...h.state,document:{...h.state.document,revision:1,sequenceEndFrame:6120,clips:Array.from({length:51},(_,i)=>({...structuredClone(template),id:'row-'+i,startFrame:i*120}))}});
  for(let i=0;i<51;i++)fireEvent.change(open(h,'row-'+i),{target:{value:'修正 '+i}});
  const execute=h.execute.getMockImplementation()!;h.execute.mockImplementationOnce(execute).mockResolvedValueOnce(false);
  await act(async()=>expect(await h.ref.current!.flush()).toBe(false));
  expect(h.execute.mock.calls.map(([c])=>c.type==='batch'?c.commands.length:0)).toEqual([50,1]);
  expect(h.state.document.clips[49]!.name).toBe('修正 49');expect(h.state.document.clips[50]!.name).toBe('前半の字幕');
  expect(open(h,'row-50')).toHaveProperty('value','修正 50');
  await act(async()=>expect(await h.ref.current!.flush()).toBe(true));
  expect(h.execute.mock.calls.map(([c])=>c.type==='batch'?c.commands.length:0)).toEqual([50,1,1]);
  expect(h.state.document.clips[50]!.name).toBe('修正 50');
});
it('collapses every row to one line and expands only the selected one',()=>{
  const h=setup();
  expect(h.view.queryByLabelText('字幕本文 one')).toBeNull();
  expect(h.view.getByText('前半の字幕')).toBeTruthy();
  h.props.selected=['one'];h.refresh();
  expect(h.view.getByLabelText('字幕本文 one')).toBeTruthy();
  expect(h.view.queryByLabelText('字幕本文 two')).toBeNull();
});
it('selects and seeks from anywhere in the row, not only the time button',()=>{
  const h=setup();
  fireEvent.click(h.view.getByText('後半の字幕'));
  expect(h.props.onSelect).toHaveBeenLastCalledWith('two',120);
});
it('shows the caption count in the heading',()=>{
  const h=setup();
  expect(h.view.getByText('2件')).toBeTruthy();
});
it('scrolls the selected row into view when the selection changes elsewhere',()=>{
  const scroll=vi.fn();
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});
  const h=setup();scroll.mockClear();
  h.props.selected=['two'];h.refresh();
  expect(scroll).toHaveBeenCalled();
});
it('persists the follow toggle across mounts',()=>{
  const h=setup();
  fireEvent.click(h.view.getByLabelText('再生に追従'));
  expect(localStorage.getItem('sme.native.caption-follow')).toBe('0');
  cleanup();
  const again=setup();
  expect((again.view.getByLabelText('再生に追従') as HTMLInputElement).checked).toBe(false);
});
it('strikes through a caption whose span is fully covered by an archived cut entry',()=>{
  const h=setup();
  const entry=cutEntry('cut-1',0,240);
  const transcripts=[{assetId:'asset',streamIndex:0,words:[{id:'w1',text:'カットされた語',start:r(1),end:r(2)}]}];
  expect(archivedWords({...h.state.document,transcripts},entry).length).toBeGreaterThan(0); // fixture actually has archived words, not just an empty entries[]
  h.replace({...h.state,document:{...h.state.document,revision:1,transcripts,cutArchive:{version:1,entries:[entry],groups:[]}}});
  expect(h.view.getByText('後半の字幕').closest('article')!.className).toContain('is-cut');
});
it('lists the source words of the selected caption as chips that seek',()=>{
  vi.spyOn(wordChips,'captionWordChips').mockReturnValue([
    {text:'前半',startFrame:0,endFrame:40,cut:false},{text:'の字幕',startFrame:40,endFrame:120,cut:true}]);
  const h=setup();h.props.selected=['one'];h.refresh();
  const chips=h.view.getAllByRole('button',{name:/へ移動$/});
  expect(chips.map(node=>node.textContent)).toEqual(['前半','の字幕']);
  expect(chips[1]!.className).toContain('is-cut');
  fireEvent.click(chips[1]!);
  expect(h.props.onSelect).toHaveBeenLastCalledWith('one',40);
});
it('keeps split, merge and delete on the expanded row only',()=>{
  const h=setup();
  expect(h.view.queryByRole('button',{name:'再生位置で分割'})).toBeNull();
  h.props.selected=['one'];h.refresh();
  expect(h.view.getByRole('button',{name:'再生位置で分割'})).toBeTruthy();
  expect(h.view.getByRole('button',{name:'次と結合'})).toBeTruthy();
});
it('tells the reader why merging is unavailable instead of just disabling it',()=>{
  const h=setup();h.props.selected=['two'];h.refresh();     // 最後の字幕には次が無い
  expect((h.view.getByRole('button',{name:'次と結合'}) as HTMLButtonElement).disabled).toBe(true);
  expect(h.view.getByRole('button',{name:'次と結合'}).title).toContain('次の字幕がありません');
});
it('does not strike through a caption when the archived entry only partly covers its span',()=>{
  const h=setup();
  // covers frames 120-200 only; caption 'two' runs 120-240, so the match condition (clipEnd(archived)>=end) must fail.
  const entry=cutEntry('cut-2',120,80);
  const transcripts=[{assetId:'asset',streamIndex:0,words:[{id:'w1',text:'一部だけ',start:r(1),end:r(2)}]}];
  expect(archivedWords({...h.state.document,transcripts},entry).length).toBeGreaterThan(0);
  h.replace({...h.state,document:{...h.state.document,revision:1,transcripts,cutArchive:{version:1,entries:[entry],groups:[]}}});
  expect(h.view.getByText('後半の字幕').closest('article')!.className).not.toContain('is-cut');
});

// --- 自動反映（入力の停止・フォーカス離脱） -------------------------------------
afterEach(()=>{vi.useRealTimers();});
/** Let the debounce fire and the whole async flush chain (prepare → execute → retry) settle. */
async function settle(ms:number){
  await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
  for(let i=0;i<3;i++)await act(async()=>{await Promise.resolve();});
}
function compose(node:HTMLElement,kind:'start'|'end',data=''){
  act(()=>{node.dispatchEvent(new CompositionEvent('composition'+kind,{bubbles:true,data}));});
}
it('applies the text as one undoable command once typing pauses',async()=>{
  vi.useFakeTimers();const h=setup();
  fireEvent.change(open(h,'one'),{target:{value:'止まったら反映'}});
  expect(h.execute).not.toHaveBeenCalled();
  await settle(1500);
  expect(h.execute).toHaveBeenCalledTimes(1);
  const command=h.execute.mock.calls[0]![0];
  expect(command.type).toBe('batch');expect(command.type==='batch'&&command.commands.length).toBe(1); // 1 pause = 1 command = 1 undo
  expect(h.state.document.clips[0]!.name).toBe('止まったら反映');
});
it('does not apply while the reader is still typing',async()=>{
  vi.useFakeTimers();const h=setup();const box=open(h,'one');
  fireEvent.change(box,{target:{value:'まだ'}});
  await settle(1000);expect(h.execute).not.toHaveBeenCalled();
  fireEvent.change(h.view.getByLabelText('字幕本文 one'),{target:{value:'まだ途中'}});
  await settle(1000);expect(h.execute).not.toHaveBeenCalled();
  await settle(500);expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.state.document.clips[0]!.name).toBe('まだ途中');
});
it('applies immediately when the text box loses focus',async()=>{
  vi.useFakeTimers();const h=setup();
  fireEvent.change(open(h,'one'),{target:{value:'離れたら反映'}});
  fireEvent.blur(h.view.getByLabelText('字幕本文 one'));
  await settle(0);
  expect(h.execute).toHaveBeenCalledTimes(1);expect(h.state.document.clips[0]!.name).toBe('離れたら反映');
});
it('waits for the IME to finish before applying Japanese input',async()=>{
  vi.useFakeTimers();const h=setup();const box=open(h,'one');
  compose(box,'start');
  fireEvent.change(box,{target:{value:'へんかんちゅう'}});
  await settle(2000);expect(h.execute).not.toHaveBeenCalled(); // 変換中は何も送らない
  fireEvent.blur(box); // Safari は変換中に blur が来ることがある
  await settle(0);expect(h.execute).not.toHaveBeenCalled();
  compose(box,'end','変換中');
  fireEvent.change(box,{target:{value:'変換済み'}});
  await settle(1499);expect(h.execute).not.toHaveBeenCalled();
  await settle(1);expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.state.document.clips[0]!.name).toBe('変換済み');
});
it('does not touch the document when a row is merely opened and left',async()=>{
  vi.useFakeTimers();const h=setup();const box=open(h,'one');
  fireEvent.focus(box);fireEvent.blur(box);
  await settle(2000);
  expect(h.execute).not.toHaveBeenCalled();expect(h.props.onDraft).not.toHaveBeenCalledWith(true);
});
it('drops the apply button and keeps Cmd+Enter as the immediate apply',async()=>{
  vi.useFakeTimers();const h=setup();
  const box=open(h,'one');
  expect(h.view.queryByRole('button',{name:'本文を反映'})).toBeNull();
  expect(h.view.getByText('本文は入力を止めると自動で反映されます。続けて直した字幕はまとめて 1 回の取り消しで戻せます。')).toBeTruthy();
  fireEvent.change(box,{target:{value:'すぐ反映'}});
  fireEvent.keyDown(h.view.getByLabelText('字幕本文 one'),{key:'Enter',metaKey:true});
  await settle(0);
  expect(h.execute).toHaveBeenCalledTimes(1);expect(h.state.document.clips[0]!.name).toBe('すぐ反映');
});
it('reports a conflict instead of auto-applying over someone else’s text',async()=>{
  vi.useFakeTimers();const h=setup();
  fireEvent.change(open(h,'one'),{target:{value:'人が書いた本文'}});
  const doc=structuredClone(h.state.document);doc.revision++;const clip=doc.clips[0]!;if(clip.content.kind==='telop')clip.content.data.text='AIが変えた本文';
  h.replace({...h.state,document:doc});
  await settle(1500);
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.view.getAllByRole('alert').length).toBeGreaterThan(0);
  expect((h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement).value).toBe('人が書いた本文');
});

it('keeps the text box usable while an automatic apply is in flight',async()=>{
  vi.useFakeTimers();const h=setup();let release!:()=>void;const deferred=new Promise<void>(resolve=>{release=resolve;});
  const apply=h.execute.getMockImplementation()!;h.execute.mockImplementationOnce(async command=>{await deferred;return apply(command);});
  const box=open(h,'one') as HTMLTextAreaElement;box.focus();
  fireEvent.change(box,{target:{value:'一文目'}});
  await settle(1500);
  expect(h.execute).toHaveBeenCalledTimes(1);
  const live=h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement;
  expect(live.disabled).toBe(false);                       // 反映中でも打てる = フォーカスを奪われない
  expect(live.readOnly).toBe(false);
  expect(live.getAttribute('aria-busy')).toBe('true');
  expect(document.activeElement).toBe(live);
  expect((h.view.getByRole('button',{name:'次と結合'}) as HTMLButtonElement).disabled).toBe(true); // ボタン類は反映中も止める
  fireEvent.change(live,{target:{value:'一文目と二文目'}});
  expect((h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement).value).toBe('一文目と二文目');
  await act(async()=>{release();await vi.advanceTimersByTimeAsync(0);});
  for(let i=0;i<4;i++)await act(async()=>{await Promise.resolve();});
  expect(h.execute).toHaveBeenCalledTimes(2);              // 反映中に足した分は再帰 flush が後から送る
  expect(h.state.document.clips[0]!.name).toBe('一文目と二文目');
  expect((h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement).getAttribute('aria-busy')).toBe('false');
});
it('freezes the text box without losing focus while the project is switching',()=>{
  const h=setup();const box=open(h,'one') as HTMLTextAreaElement;box.focus();
  h.props.busy=true;h.props.switching=true;h.refresh();
  const live=h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement;
  expect(live.readOnly).toBe(true);expect(live.disabled).toBe(false);expect(document.activeElement).toBe(live);
});

it('drops the pending apply when the session is replaced under the same project',async()=>{
  vi.useFakeTimers();const h=setup();
  fireEvent.change(open(h,'one'),{target:{value:'再接続前の入力'}});
  h.replace({...h.state,sessionId:'session-b'});   // 案件は同じまま、セッションだけ張り直す
  await settle(1500);await settle(1500);
  expect(h.execute).not.toHaveBeenCalled();        // 古い下書きを新セッションへ流し込まない
  expect(h.view.queryByRole('alert')).toBeNull();
  expect((h.view.getByLabelText('字幕本文 one') as HTMLTextAreaElement).value).toBe('再接続前の入力');
});

it('collapses a repeated row tap only after its draft is applied',async()=>{
  const h=setup();h.props.onCollapse.mockImplementation(id=>{h.props.selected=h.props.selected.filter(value=>value!==id);h.refresh();});
  fireEvent.change(open(h,'one'),{target:{value:'閉じても残る修正'}});
  fireEvent.click(h.view.getByText('閉じても残る修正',{selector:'.native-caption-text'}));
  await waitFor(()=>expect(h.view.queryByLabelText('字幕本文 one')).toBeNull());
  expect(h.state.document.clips[0]!.name).toBe('閉じても残る修正');expect(h.props.onSelect).not.toHaveBeenCalled();
});
it('keeps a repeated-tap detail open when applying fails',async()=>{
  const h=setup();h.execute.mockResolvedValueOnce(false);fireEvent.change(open(h,'one'),{target:{value:'残す入力'}});
  fireEvent.click(h.view.getByText('残す入力',{selector:'.native-caption-text'}));
  await waitFor(()=>expect(h.view.getByRole('alert')).toBeTruthy());
  expect(h.props.onCollapse).not.toHaveBeenCalled();expect(h.view.getByLabelText('字幕本文 one')).toHaveProperty('value','残す入力');
});
it('a blur save becoming busy before the row click still closes after saving',async()=>{
  const h=setup();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const apply=h.execute.getMockImplementation()!;
  h.execute.mockImplementationOnce(async command=>{h.props.busy=true;h.refresh();await wait;return apply(command);});
  fireEvent.change(open(h,'one'),{target:{value:'ぼかし保存'}});fireEvent.blur(h.view.getByLabelText('字幕本文 one'));
  await waitFor(()=>expect(h.execute).toHaveBeenCalled());fireEvent.click(h.view.getByText('ぼかし保存',{selector:'.native-caption-text'}));
  await act(async()=>{release();});await waitFor(()=>expect(h.props.onCollapse).toHaveBeenCalledWith('one'));
});
