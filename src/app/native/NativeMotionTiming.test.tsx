/** @vitest-environment jsdom */
import {createRef} from 'react';
import {NativeMotionTiming} from './NativeMotionTiming';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {NativeApiError,type NativeCommand} from './api';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {applySequenceCommand} from '../../core/sequence/commands';
import {SequenceSession} from '../../core/sequence/session';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r,rationalFromBigInts} from '../../core/sequence/time';
import {sampleVisualTransform} from '../../core/sequence/visualTransform';
import {firstMotionKeySeconds,motionRateClock,motionStartClock,motionTimingValue,parseMotionTiming} from './motionTiming';
afterEach(cleanup);

function fixture(own=true):SequenceDocument {
 const doc:SequenceDocument={schemaVersion:2,id:'motion',name:'動き',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
  assets:[{id:'asset',kind:'media',file:'media/input.mp4',name:'素材',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
  tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
  clips:[{id:'v0',trackId:'v',name:'挿入',startFrame:60,durationFrames:120,linkGroupId:'pair',clock:{offset:r(-15),rate:r(1),duration:r(120)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[{frame:r(15),value:{opacity:0}},{frame:r(75),value:{opacity:1}}]},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(1),rate:r(1)}},
   {id:'a0',trackId:'a',name:'原音',startFrame:60,durationFrames:120,linkGroupId:'pair',clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(1),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
 return own?applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'v0',linked:true}):doc;
}
function harness(initial=fixture()){
 const session=new SequenceSession('motion',initial),ref=createRef<NativeInspectorHandle>(),commands:NativeCommand[]=[];let id=0,gate:(()=>Promise<boolean>)|undefined;
 const run=(command:NativeCommand)=>{const result=session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:`ui-${++id}`,command});view.rerender(element());return result;};
 const dispatch=async(command:NativeCommand)=>{commands.push(command);if(gate&&!await gate())return false;run(command);return true;};
 const element=()=> <NativeInspector ref={ref} projectId="motion" document={session.document} readDocument={()=>session.document} frame={90} onSeek={()=>{}} selected={['v0']} disabled={false} bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>;
 const view=render(element());return {ref,view,commands,run,get doc(){return session.document;},setGate(value:typeof gate){gate=value;}};
}
async function input(h:ReturnType<typeof harness>,label:string,text:string){let ok=false;await act(async()=>{const field=h.view.getByLabelText(label);field.focus();fireEvent.change(field,{target:{value:text}});fireEvent.keyDown(field,{key:'Enter'});ok=await h.ref.current!.flush();});return ok;}

it('changes motion pace around the first point without editing linked media or length',async()=>{
 const h=harness(),before=h.doc;expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toHaveProperty('value','1');
 expect(await input(h,'動きの速さ（倍）','2')).toBe(true);
 const clip=h.doc.clips[0]!;expect(clip.visual!.keyframeClock).toEqual({offset:r(-45),rate:r(2),duration:r(120)});
 expect(firstMotionKeySeconds(clip,h.doc.fps)).toEqual(r(1));expect(sampleVisualTransform(clip,105).opacity).toBeCloseTo(.5,12);
 expect(clip.content).toEqual(before.clips[0]!.content);expect(clip.durationFrames).toBe(120);expect(h.doc.clips[1]).toEqual(before.clips[1]);expect(h.doc.sequenceEndFrame).toBe(180);
 expect(h.commands).toEqual([{type:'rebase-native-insert-own-keyframe-clock',clipId:'v0',clock:{offset:r(-45),rate:r(2),duration:r(120)}}]);
});
it('sets a signed first-point position exactly, then resets through one Undoable command',async()=>{
 const h=harness();expect(await input(h,'最初の点（クリップ内秒）','-1/3')).toBe(true);
 expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toHaveProperty('value','-1/3');expect(h.doc.clips[0]!.visual!.keyframeClock!.offset).toEqual(r(25));
 await act(async()=>{fireEvent.click(h.view.getByText('素材の動きに合わせる'));await h.ref.current!.flush();});
 expect(h.doc.clips[0]!.visual!.keyframeClock).toBeUndefined();expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toHaveProperty('value','1');
 await act(async()=>{h.run({type:'undo'});});expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toHaveProperty('value','-1/3');
 await act(async()=>{h.run({type:'redo'});});expect(h.view.getByText('素材の動きに合わせる')).toHaveProperty('disabled',true);
});
it.each(['0','-1','NaN','Infinity','1/0','1.00000000000000001'])('keeps invalid pace %s as a draft that blocks flush',async value=>{
 const h=harness(),before=h.doc;expect(await input(h,'動きの速さ（倍）',value)).toBe(false);expect(h.doc).toEqual(before);expect(h.commands).toHaveLength(0);
 const field=h.view.getByLabelText('動きの速さ（倍）');expect(field.getAttribute('aria-invalid')).toBe('true');
 await act(async()=>{field.focus();fireEvent.keyDown(field,{key:'Escape'});expect(await h.ref.current!.flush()).toBe(true);});expect(field).toHaveProperty('value','1');
});
it('uses current queued pace when a following position draft is committed',async()=>{
 const h=harness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});h.setGate(async()=>{await gate;return true;});
 const pace=h.view.getByLabelText('動きの速さ（倍）');pace.focus();fireEvent.change(pace,{target:{value:'2'}});fireEvent.keyDown(pace,{key:'Enter'});await waitFor(()=>expect(h.commands).toHaveLength(1));
 const start=h.view.getByLabelText('最初の点（クリップ内秒）');start.focus();fireEvent.change(start,{target:{value:'1/2'}});
 let finished=false;const flushed=h.ref.current!.flush().then(ok=>{finished=true;return ok;});expect(finished).toBe(false);
 await act(async()=>{release();expect(await flushed).toBe(true);});expect(h.commands).toHaveLength(2);expect(h.doc.clips[0]!.visual!.keyframeClock).toEqual({offset:r(-15),rate:r(2),duration:r(120)});
});
it.each(['false','overflow'])('shows a failed %s action and allows a corrected retry',async mode=>{
 const h=harness(),before=h.doc;h.setGate(async()=>{if(mode==='overflow')throw new NativeApiError('internal arithmetic',400,'TIME_OVERFLOW');return false;});
 expect(await input(h,'動きの速さ（倍）','2')).toBe(false);expect(h.doc).toEqual(before);expect(h.view.getByRole('alert').textContent).toMatch(mode==='overflow'?/正確に保存できません/:/変更|保存|適用/);
 h.setGate(undefined);expect(await input(h,'動きの速さ（倍）','3/2')).toBe(true);expect(h.doc.clips[0]!.visual!.keyframeClock!.rate).toEqual(r(3,2));
});
it('leaves unregistered clips unchanged and does not expose an unsupported timing action',()=>{
 const h=harness(fixture(false));expect(h.view.queryByLabelText('動きの速さ（倍）')).toBeNull();expect(h.commands).toHaveLength(0);
});
it('formats negative finite decimals and protects equal-rate no-ops from extra arithmetic',()=>{
 expect(motionTimingValue(r(-1,20))).toBe('-0.05');expect(parseMotionTiming('-0.05')).toEqual(r(-1,20));
 const c=fixture().clips[0]!;c.visual!.keyframeClock={offset:r(-Number.MAX_SAFE_INTEGER),rate:r(1),duration:r(120)};
 expect(motionRateClock(c,r(2,2))).toBe(c.visual!.keyframeClock);
});
it('does not forward typing shortcuts to playback',()=>{
 const h=harness(),listener=vi.fn();window.addEventListener('keydown',listener);try{fireEvent.keyDown(h.view.getByLabelText('動きの速さ（倍）'),{key:'l'});expect(listener).not.toHaveBeenCalled();}finally{window.removeEventListener('keydown',listener);}
});
it('reduces the final timing result before checking storage limits',()=>{
 const c=fixture().clips[0]!;c.visual!.keyframes=[{frame:r(1),value:{opacity:1}}];
 c.visual!.keyframeClock={offset:r(-Number.MAX_SAFE_INTEGER),rate:r(1),duration:r(120)};
 // first-offset is 2^53 (too large to store), but its halved result is representable.
 expect(motionRateClock(c,r(1,2)).offset).toEqual(r(-4503599627370495));
 expect(firstMotionKeySeconds(c,r(2))).toEqual(r(4503599627370496));
 expect(motionStartClock(c,r(2),r(4503599627370496),r(1)).offset).toEqual(r(-Number.MAX_SAFE_INTEGER));
 expect(rationalFromBigInts(2n**100n,2n**101n)).toEqual(r(1,2));
 expect(()=>rationalFromBigInts(2n**53n,1n)).toThrowError('時刻の精度を保てる範囲を超えています');
});
it('labels clip-relative seconds explicitly beside absolute timeline key positions',()=>{
 const h=harness();expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toHaveProperty('value','1');
 expect(h.view.getByText('点 1 · 3.00 秒')).toBeTruthy();
});
it.each(['動きの速さ（倍）','最初の点（クリップ内秒）'])('reports local exact-arithmetic overflow in %s without dispatch, then recovers',async label=>{
 const h=harness(),before=h.doc;expect(await input(h,label,String(Number.MAX_SAFE_INTEGER))).toBe(false);
 expect(h.doc).toEqual(before);expect(h.commands).toHaveLength(0);expect(h.view.getByRole('alert').textContent).toContain('時間の設定を正確に保存できません');
 expect(await input(h,label,'2')).toBe(true);expect(h.commands).toHaveLength(1);
});
it('shows the exact-display fallback and permits reset when first seconds exceed storage precision',async()=>{
 const initial=fixture(false);initial.fps=r(31);initial.clips[0]!.visual!.keyframeClock={offset:r(-Number.MAX_SAFE_INTEGER),rate:r(1),duration:r(120)};
 const h=harness(applySequenceCommand(initial,{type:'register-native-insert-own-speed',clipId:'v0',linked:true}));
 expect(h.view.queryByLabelText('最初の点（クリップ内秒）')).toBeNull();expect(h.view.getByText(/最初の点の位置を正確に表示できません/)).toBeTruthy();
 expect(h.view.getByLabelText('動きの速さ（倍）')).toHaveProperty('value','1');
 await act(async()=>{fireEvent.click(h.view.getByText('素材の動きに合わせる'));expect(await h.ref.current!.flush()).toBe(true);});
 expect(h.doc.clips[0]!.visual!.keyframeClock).toBeUndefined();expect(h.view.getByLabelText('最初の点（クリップ内秒）')).toBeTruthy();
});
it.each(['動きの速さ（倍）','最初の点（クリップ内秒）'])('rejects a changed first key when the queued %s builder executes',async label=>{
 const clip=fixture().clips[0]!,changed=structuredClone(clip);changed.visual!.keyframes.shift();let failure='';
 const edit=async(build:(current:typeof clip)=>NativeCommand)=>{try{build(changed);return true;}catch(error){failure=(error as Error).message;return false;}};
 const view=render(<NativeMotionTiming clip={clip} fps={r(30)} onEdit={edit} onAction={edit}/>);
 await act(async()=>{const field=view.getByLabelText(label);field.focus();fireEvent.change(field,{target:{value:'2'}});fireEvent.keyDown(field,{key:'Enter'});});
 expect(failure).toContain('最初の点が変わりました');expect(view.getByLabelText(label)).toHaveProperty('value','1');
});
