/** @vitest-environment jsdom */
import {createRef} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {INSPECTOR_GROUPS} from './inspectorSections';
import {parseSpeedInput,speedInputValue,speedRegistrationOptions,registrationCommand} from './speedSettings';
import {applySequenceCommand} from '../../core/sequence/commands';
import {validateSequenceDocument} from '../../core/sequence/validate';
import type {SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {rational as r} from '../../core/sequence/time';
import {formatRate,rateToSlider,sliderToRate} from './speedScale';
afterEach(cleanup);
function fixture(rate=1):SequenceDocument{return {schemaVersion:2,id:'doc',name:'速度',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],assets:[{id:'asset',kind:'media',file:'media/input.mp4',name:'素材',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'音声',enabled:true}],clips:[0,1].flatMap(i=>[{id:`v${i}`,trackId:'v',name:`映像${i}`,startFrame:i*60,durationFrames:60,linkGroupId:`link${i}`,clock:{offset:r(-2),rate:r(2),duration:r(120)},content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i*10),rate:r(rate)}},{id:`a${i}`,trackId:'a',name:`原音${i}`,startFrame:i*60,durationFrames:60,linkGroupId:`link${i}`,clock:{offset:r(-3),rate:r(3),duration:r(120)},content:{kind:'audio' as const,assetId:'asset',streamIndex:1,sourceIn:r(i*10),rate:r(rate),role:'speech' as const,loop:false,settings:{gainDb:0,muted:false,fadeInFrames:3,fadeOutFrames:4}}}])};}
function registered(rate=1){return applySequenceCommand(fixture(rate),registrationCommand(fixture(rate),['v0','v1'],'group'));}
/** F14: 調整タブの群は既定で畳まれる。この検証は群の開閉が主題ではないので全群を開いて描く。 */
const OPEN_ALL=Object.fromEntries(INSPECTOR_GROUPS.flatMap(group=>(['none','telop','title','video','image','audio','shape','scene-fade','multi'] as const).map(kind=>[`${kind}:${group.id}`,true])));
function harness(initial=registered(),selected=['v0']){
 let doc=initial,block:(()=>Promise<boolean>)|undefined;const ref=createRef<NativeInspectorHandle>(),commands:NativeCommand[]=[];
 const dispatch=async(command:NativeCommand)=>{commands.push(command);const version=doc.revision;if(block&&!await block())return false;if(version!==doc.revision)return false;if(command.type==='undo'||command.type==='redo')throw Error('unexpected history');doc=applySequenceCommand(doc,command);view.rerender(element());return true;};
 const element=()=> <NativeInspector ref={ref} groupOpen={OPEN_ALL} projectId="private" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={selected} disabled={false} bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>;
 const view=render(element());return {view,ref,commands,get doc(){return doc;},setDoc(value:SequenceDocument){doc=value;view.rerender(element());},setBlock(value:typeof block){block=value;}};
}
async function input(h:ReturnType<typeof harness>,label:string,text:string){await act(async()=>{const field=h.view.getByLabelText(label);field.focus();fireEvent.change(field,{target:{value:text}});fireEvent.keyDown(field,{key:'Enter'});await h.ref.current!.flush();});}
it.each(['',' ','NaN','Infinity','1e999','0','-1','0.09','16.01','1/0','1/3/4','1,36','9007199254740993/9007199254740993','1.00000000000000001'])('rejects exact invalid input %s without a clamped replacement',text=>expect(()=>parseSpeedInput(text)).toThrow());
it.each([['1.36',r(34,25)],['0.1',r(1,10)],['16',r(16)],['2/6',r(1,3)],['1.000000000000001',r(1000000000000001,1000000000000000)] ] as const)('preserves decimal/fraction input %s', (text,expected)=>expect(parseSpeedInput(text)).toEqual(expected));
it.each([r(34,25),r(1,3),r(1,10),r(16),r(1000000000000001,1000000000000000)])('displays a Rational losslessly %#',rate=>expect(parseSpeedInput(speedInputValue(rate))).toEqual(rate));
it('lists only explicit linked speech candidates and rejects unsupported links',()=>{const d=fixture();const opts=speedRegistrationOptions(d);expect(opts.map(o=>o.audio.map(a=>a.id))).toEqual([['a0'],['a1']]);const command=registrationCommand(d,['v1'],'group');expect(command.mainClipIds).toEqual(['v1']);expect(command.mainAudioBindings).toEqual([{audioClipId:'a1',providerId:'v1'}]);if(d.clips[1]!.content.kind==='audio')d.clips[1]!.content.role='music';expect(speedRegistrationOptions(d)[0]!.issue).toContain('原音0');expect(()=>registrationCommand(d,['v0'],'group')).toThrow();});
it('registers only the visibly selected video and its displayed original audio, with all timing unchanged',async()=>{const original=fixture(2),h=harness(original,[]);const boxes=h.view.getAllByRole('checkbox') as HTMLInputElement[];expect(boxes.every(b=>!b.checked)).toBe(true);fireEvent.click(h.view.getByLabelText(/映像1/));fireEvent.click(h.view.getByText('選んだ映像と原音を登録'));await waitFor(()=>expect(h.doc.speed).toBeDefined());expect(h.commands).toHaveLength(1);expect(h.doc.clips.filter(c=>c.speed).map(c=>c.id)).toEqual(['v1','a1']);expect(h.doc.clips.map(({speed,...clip})=>clip)).toEqual(original.clips);expect(h.view.getByLabelText('全体の倍率')).toHaveProperty('value','2');});
it('distinguishes a same-value override from global following, then resets the key',async()=>{const h=harness(registered(2));fireEvent.change(h.view.getByLabelText('速度の指定'),{target:{value:'override'}});await waitFor(()=>expect(h.doc.clips[0]!.speed).toHaveProperty('override',r(2)));await input(h,'全体の倍率','1.36');expect(h.doc.speed!.globalRate).toEqual(r(34,25));expect(h.doc.clips[0]!.content).toHaveProperty('rate',r(2));fireEvent.click(h.view.getByText('全体へ戻す'));await waitFor(()=>expect(h.doc.clips[0]!.speed).not.toHaveProperty('override'));expect(h.doc.clips[0]!.content).toHaveProperty('rate',r(34,25));});
it('keeps invalid draft dirty so save/view flush fails; Escape restores saved exact value without dispatch',async()=>{const h=harness();await input(h,'全体の倍率','99');expect(h.doc.speed!.globalRate).toEqual(r(1));expect(h.commands).toHaveLength(0);expect(h.view.getByLabelText('全体の倍率')).toHaveProperty('value','99');await act(async()=>expect(await h.ref.current!.flush()).toBe(false));const field=h.view.getByLabelText('全体の倍率');field.focus();fireEvent.keyDown(field,{key:'Escape'});await act(async()=>expect(await h.ref.current!.flush()).toBe(true));expect(field).toHaveProperty('value','1');expect(h.commands).toHaveLength(0);});
it('preserves newer drafts while a prior save is pending and flush waits for both through the shared queue',async()=>{const h=harness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});h.setBlock(async()=>{await gate;return true;});const field=h.view.getByLabelText('全体の倍率');field.focus();fireEvent.change(field,{target:{value:'2'}});fireEvent.keyDown(field,{key:'Enter'});await waitFor(()=>expect(h.commands).toHaveLength(1));field.focus();fireEvent.change(field,{target:{value:'1.36'}});let finished=false;const flushed=h.ref.current!.flush().then(value=>{finished=true;return value;});expect(finished).toBe(false);await act(async()=>{release();expect(await flushed).toBe(true);});expect(h.commands).toHaveLength(2);expect(h.doc.speed!.globalRate).toEqual(r(34,25));});
it('rejects an external revision and allows a corrected retry after a refused command',async()=>{const h=harness();h.setBlock(async()=>false);await input(h,'全体の倍率','2');expect(h.doc.speed!.globalRate).toEqual(r(1));h.setBlock(undefined);await input(h,'全体の倍率','1.36');expect(h.doc.speed!.globalRate).toEqual(r(34,25));const saved=h.doc;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});h.setBlock(async()=>{await gate;return true;});const field=h.view.getByLabelText('全体の倍率');field.focus();fireEvent.change(field,{target:{value:'3'}});fireEvent.keyDown(field,{key:'Enter'});await waitFor(()=>expect(h.commands).toHaveLength(3));const external={...saved,revision:saved.revision+1,name:'外部編集'};h.setDoc(external);const flushed=h.ref.current!.flush();await act(async()=>{release();expect(await flushed).toBe(false);});expect(h.doc).toEqual(external);});
it('stops playback shortcut propagation while typing the rate',()=>{const h=harness(),listener=vi.fn();window.addEventListener('keydown',listener);try{fireEvent.keyDown(h.view.getByLabelText('全体の倍率'),{key:'l'});expect(listener).not.toHaveBeenCalled();}finally{window.removeEventListener('keydown',listener);}});
it('shows provider linkage for registered original audio and keeps independent material explicitly separate',()=>{const h=harness(registered(),['a0']);expect(h.view.getByText(/映像0/)).toBeTruthy();expect(h.view.queryByLabelText('このクリップの倍率')).toBeNull();cleanup();const fixed=harness(fixture(),['a0']);expect(fixed.view.getByText(/全体の速度に連動していません/)).toBeTruthy();expect(fixed.view.queryByLabelText('速度の指定')).toBeNull();});
it('keeps an empty registered main sequence explanatory without exposing a failing speed field',()=>{const doc=applySequenceCommand(registered(),{type:'delete',clipIds:['v0','v1'],linked:true}),h=harness(doc,[]);expect(h.view.getByText(/主映像が削除/)).toBeTruthy();expect(h.view.queryByLabelText('全体の倍率')).toBeNull();expect(h.commands).toHaveLength(0);});
it('checks the linked original audio before offering insert-own registration',()=>{
 const doc=fixture();if(doc.clips[1]!.content.kind==='audio'){doc.clips[1]!.content.loop=true;doc.clips[1]!.content.role='music';}validateSequenceDocument(doc);
 const h=harness(doc,['v0']);expect(h.view.queryByText('この素材の速度を設定')).toBeNull();
 expect(h.view.getByText(/原音0.*ループ音声/)).toBeTruthy();expect(h.commands).toHaveLength(0);expect(h.doc).toEqual(doc);
});
it.each(['false','throw'])('reports an insert-own action failure through the existing Inspector queue: %s',mode=>{
 return (async()=>{const doc=fixture(),h=harness(doc,['v0']);h.setBlock(async()=>{if(mode==='throw')throw Error('原音0: 変更を拒否しました');return false;});
 fireEvent.click(h.view.getByText('この素材の速度を設定'));
 await waitFor(()=>expect(h.view.getByRole('alert').textContent).toMatch(/拒否|失敗|適用|変更/));
 expect(h.doc).toEqual(doc);expect(h.commands).toHaveLength(1);
 })();
});
it('clicking a global preset dispatches set-native-global-speed exactly once with the picked rate',async()=>{
 const h=harness();
 fireEvent.click(h.view.getByRole('button',{name:formatRate(2)}));
 await waitFor(()=>expect(h.doc.speed!.globalRate).toEqual(r(2)));
 expect(h.commands).toHaveLength(1);expect(h.commands[0]).toEqual({type:'set-native-global-speed',rate:r(2)});
});
it('dragging the global slider dispatches set-native-global-speed exactly once with the slider-derived rate',async()=>{
 const h=harness(),slider=h.view.getByLabelText('全体の速度スライダー');
 const position=rateToSlider(4);
 fireEvent.change(slider,{target:{value:String(position)}});
 await waitFor(()=>expect(h.commands).toHaveLength(1));
 expect(h.commands[0]!.type).toBe('set-native-global-speed');
 expect((h.commands[0] as {rate:unknown}).rate).toEqual(parseSpeedInput(String(sliderToRate(position))));
 expect(h.doc.speed!.globalRate).toEqual(parseSpeedInput(String(sliderToRate(position))));
});
it('clicking a clip-override preset dispatches set-native-main-speed exactly once with the picked rate',async()=>{
 const h=harness(registered(2));
 fireEvent.change(h.view.getByLabelText('速度の指定'),{target:{value:'override'}});
 await waitFor(()=>expect(h.doc.clips[0]!.speed).toHaveProperty('override',r(2)));
 const before=h.commands.length;
 fireEvent.click(within(h.view.getByRole('group',{name:'このクリップのよく使う倍率'})).getByRole('button',{name:formatRate(1)}));
 await waitFor(()=>expect(h.doc.clips[0]!.content).toHaveProperty('rate',r(1)));
 expect(h.commands).toHaveLength(before+1);
 expect(h.commands[before]).toEqual({type:'set-native-main-speed',clipId:'v0',rate:r(1)});
});
it('dragging the clip-override slider dispatches set-native-main-speed exactly once with the slider-derived rate',async()=>{
 const h=harness(registered(2));
 fireEvent.change(h.view.getByLabelText('速度の指定'),{target:{value:'override'}});
 await waitFor(()=>expect(h.doc.clips[0]!.speed).toHaveProperty('override',r(2)));
 const before=h.commands.length,slider=h.view.getByLabelText('このクリップの速度スライダー'),position=rateToSlider(8);
 fireEvent.change(slider,{target:{value:String(position)}});
 await waitFor(()=>expect(h.commands).toHaveLength(before+1));
 expect(h.commands[before]).toEqual({type:'set-native-main-speed',clipId:'v0',rate:parseSpeedInput(String(sliderToRate(position)))});
 expect(h.doc.clips[0]!.content).toHaveProperty('rate',parseSpeedInput(String(sliderToRate(position))));
});
