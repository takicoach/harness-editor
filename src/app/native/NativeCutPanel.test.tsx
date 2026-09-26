/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeCutPanel,type NativeCutHandle} from './NativeCutPanel';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
import type {SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand,NativeSession} from './api';
import {parseSequence,serializeSequence} from '../../core/sequence/validate';
afterEach(cleanup);
function setup(compact=false){
  const original:SequenceDocument={schemaVersion:2,id:'project',name:'復元',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:180,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[],transcripts:[],transitions:[],tracks:[{id:'t',kind:'visual',name:'字幕',enabled:true}],clips:[{id:'caption',name:'元の字幕',trackId:'t',startFrame:0,durationFrames:180,clock:{offset:r(0),rate:r(1),duration:r(180)},content:{kind:'telop',data:{text:'元の字幕'}}}]};
  // Reopen a saved cut; this UI must work without any Undo history.
  const doc=parseSequence(serializeSequence(applySequenceCommand(original,{type:'ripple-delete',startFrame:60,endFrame:120})));
  let state:NativeSession={sessionId:'one',document:doc,savedRevision:doc.revision,savedContentHash:'saved',dirty:false,canUndo:false,canRedo:false};
  const ref=createRef<NativeCutHandle>(),execute=vi.fn(async(command:NativeCommand)=>{
    if(command.type==='undo'||command.type==='redo')return false;
    state={...state,document:applySequenceCommand(state.document,command)};refresh();return true;
  });
  const props={projectId:'project',state,compact,visible:true,busy:false,frame:15,activeId:null as string|null,read:()=>state,prepare:vi.fn(async()=>true),execute,onWorking:vi.fn(),onRestored:vi.fn()};
  const view=render(<NativeCutPanel {...props} ref={ref}/>);
  function refresh(){props.state=state;view.rerender(<NativeCutPanel {...props} ref={ref}/>);}
  return {ref,props,view,execute,get state(){return state;},replace(next:NativeSession){state=next;refresh();}};
}
it('restores a saved whole cut with no Undo, then removes the archive row',async()=>{
  const h=setup();expect(h.state.canUndo).toBe(false);fireEvent.click(h.view.getByText('このカットを戻す'));
  await waitFor(()=>expect(h.props.onRestored).toHaveBeenCalledWith(60));
  expect(h.state.document.sequenceEndFrame).toBe(180);expect(h.state.document.cutArchive?.entries??[]).toHaveLength(0);
  expect(h.execute.mock.calls[0]![0].type).toBe('restore-cut');expect(h.props.onWorking).toHaveBeenLastCalledWith(false);
});
it('shows saved cut text in the compact caption list and restores through the existing command',async()=>{
  const h=setup(true);
  expect(h.view.getByRole('heading',{name:'カット済みの発話・区間'})).toBeTruthy();
  expect(h.view.container.querySelector('s')?.textContent).toBe('元の字幕');
  expect(h.view.queryByLabelText('戻す範囲の開始フレーム')).toBeNull();
  fireEvent.click(h.view.getByText('このカットを戻す'));
  await waitFor(()=>expect(h.state.document.cutArchive?.entries??[]).toHaveLength(0));
  expect(h.state.document.sequenceEndFrame).toBe(180);
  expect(h.execute.mock.calls[0]![0].type).toBe('restore-cut');
  expect(h.props.onRestored).toHaveBeenCalledWith(60);
  expect(h.view.queryByRole('region',{name:'カットした部分'})).toBeNull();
});
it('keeps a compact cut available when input preparation fails',async()=>{
  const h=setup(true),before=serializeSequence(h.state.document);h.props.prepare.mockResolvedValue(false);
  fireEvent.click(h.view.getByText('このカットを戻す'));
  await waitFor(()=>expect(h.props.onWorking).toHaveBeenLastCalledWith(false));
  expect(h.execute).not.toHaveBeenCalled();expect(serializeSequence(h.state.document)).toBe(before);
  expect(h.view.getByText('このカットを戻す')).toBeTruthy();
});
it('reveals the selected band when its panel becomes visible or changes to detailed layout',()=>{
  const previous=Element.prototype.scrollIntoView,scroll=vi.fn();Element.prototype.scrollIntoView=scroll;
  try{
    const h=setup(true);h.props.visible=false;h.props.activeId=h.state.document.cutArchive!.entries[0]!.id;h.replace({...h.state});
    expect(scroll).not.toHaveBeenCalled();
    h.props.visible=true;h.replace({...h.state});expect(scroll).toHaveBeenCalledWith({block:'nearest'});
    scroll.mockClear();h.props.compact=false;h.replace({...h.state});expect(scroll).toHaveBeenCalledWith({block:'nearest'});
  }finally{Element.prototype.scrollIntoView=previous;}
});
it('restores a selected middle band and leaves both ends available for later restoration',async()=>{
  const h=setup();fireEvent.change(h.view.getByLabelText('戻す範囲の開始フレーム'),{target:{value:'10'}});fireEvent.change(h.view.getByLabelText('戻す範囲の終了フレーム'),{target:{value:'40'}});
  fireEvent.click(h.view.getByText('選択部分を戻す'));
  await waitFor(()=>expect(h.props.onRestored).toHaveBeenCalled());
  expect(h.state.document.sequenceEndFrame).toBe(150);expect(h.state.document.cutArchive!.entries.map(e=>e.durationFrames)).toEqual([10,20]);
  expect(h.execute.mock.calls[0]![0]).toMatchObject({type:'restore-cut',range:{startFrame:10,endFrame:40}});
});
it('requires an explicit playhead choice when the old boundary is ambiguous',async()=>{
  const h=setup(),doc=structuredClone(h.state.document);doc.revision++;doc.cutArchive!.entries[0]!.boundary.ambiguous=true;h.replace({...h.state,document:doc});
  expect(h.view.getByText('このカットを戻す')).toHaveProperty('disabled',true);
  fireEvent.click(h.view.getByRole('checkbox'));fireEvent.click(h.view.getByText('このカットを戻す'));
  await waitFor(()=>expect(h.props.onRestored).toHaveBeenCalledWith(15));expect(h.execute.mock.calls[0]![0]).toMatchObject({type:'restore-cut',atFrame:15});
});
it('blocks duplicate restore and makes panel flush await the actual command result',async()=>{
  const h=setup();let release!:(ok:boolean)=>void;h.execute.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  fireEvent.click(h.view.getByText('このカットを戻す'));await waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(1));
  fireEvent.click(h.view.getByText('このカットを戻す'));let settled=false;const pending=h.ref.current!.flush().then(ok=>{settled=true;return ok;});expect(settled).toBe(false);
  await act(async()=>{release(false);expect(await pending).toBe(false);});
  expect(h.execute).toHaveBeenCalledTimes(1);expect(h.view.getByRole('alert').textContent).toContain('戻せませんでした');expect(h.state.document.cutArchive!.entries).toHaveLength(1);
});
it('does not use a changed band after the pre-command input flush',async()=>{
  const h=setup();let release!:()=>void;h.props.prepare.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);}));
  fireEvent.click(h.view.getByText('このカットを戻す'));
  const doc=structuredClone(h.state.document);doc.revision++;doc.cutArchive!.entries[0]!.boundary.hintFrame++;h.replace({...h.state,document:doc});
  await act(async()=>release());await waitFor(()=>expect(h.view.getByRole('alert').textContent).toContain('区間が変わりました'));
  expect(h.execute).not.toHaveBeenCalled();
});
it('retires an old session completion without changing the reopened project',async()=>{
  const h=setup();let release!:(ok:boolean)=>void;h.execute.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  fireEvent.click(h.view.getByText('このカットを戻す'));await waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(1));
  h.replace({...h.state,sessionId:'two'});await act(async()=>release(true));expect(h.props.onRestored).not.toHaveBeenCalled();expect(h.props.onWorking).toHaveBeenLastCalledWith(false);
});
it('retains a partial selection when unrelated input saves before a rejected restore',async()=>{
  const h=setup();fireEvent.change(h.view.getByLabelText('戻す範囲の開始フレーム'),{target:{value:'10'}});fireEvent.change(h.view.getByLabelText('戻す範囲の終了フレーム'),{target:{value:'40'}});
  h.props.prepare.mockImplementationOnce(async()=>{
    const doc=structuredClone(h.state.document);doc.revision++;doc.name='別の入力を保存';h.replace({...h.state,document:doc});return true;
  });
  h.execute.mockResolvedValueOnce(false);fireEvent.click(h.view.getByText('選択部分を戻す'));
  await waitFor(()=>expect(h.view.getByRole('alert').textContent).toContain('戻せませんでした'));
  expect(h.view.getByLabelText('戻す範囲の開始フレーム')).toHaveProperty('value','10');
  expect(h.view.getByLabelText('戻す範囲の終了フレーム')).toHaveProperty('value','40');
  fireEvent.click(h.view.getByText('選択部分を戻す'));
  await waitFor(()=>expect(h.props.onRestored).toHaveBeenCalled());
  expect(h.execute.mock.calls[1]![0]).toMatchObject({type:'restore-cut',range:{startFrame:10,endFrame:40}});
});
it('flushes drafts and holds navigation until the old-cut import actually settles, without duplicate import',async()=>{
  const h=setup();h.state.document.legacy={sourceFingerprint:'a'.repeat(64),primaryAssetId:'main',originalEndFrame:180};
  let release!:(ok:boolean)=>void;const load=vi.fn(()=>new Promise<boolean>(resolve=>{release=resolve;}));
  h.view.rerender(<NativeCutPanel {...h.props} onImportLegacyHistory={load} ref={h.ref}/>);
  fireEvent.click(h.view.getByText('旧カットを読み込む'));await waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  expect(h.props.prepare).toHaveBeenCalledTimes(1);fireEvent.click(h.view.getByText('旧カットを読み込む'));
  let settled=false;const pending=h.ref.current!.flush().then(ok=>{settled=true;return ok;});expect(settled).toBe(false);
  await act(async()=>{release(false);expect(await pending).toBe(false);});
  expect(load).toHaveBeenCalledTimes(1);expect(h.view.getByRole('alert').textContent).toContain('旧カットを読み込めませんでした');
  expect(h.props.onWorking).toHaveBeenLastCalledWith(false);
});
it('does not offer old-cut import for a native-only project or after its persistent import marker exists',()=>{
  const h=setup(),load=vi.fn(async()=>true);
  h.view.rerender(<NativeCutPanel {...h.props} onImportLegacyHistory={load} ref={h.ref}/>);expect(h.view.queryByText('旧カットを読み込む')).toBeNull();
  h.state.document.legacy={sourceFingerprint:'a'.repeat(64),primaryAssetId:'main',originalEndFrame:180};
  Object.assign(h.state.document.legacy,{cutHistoryImport:{version:1,sourceFingerprint:'a'.repeat(64)}});
  h.view.rerender(<NativeCutPanel {...h.props} onImportLegacyHistory={load} ref={h.ref}/>);expect(h.view.queryByText('旧カットを読み込む')).toBeNull();
});
