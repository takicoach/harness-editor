/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeFinishCutTrack,finishCutTarget,finishRestoreCommands,type NativeFinishCutTrackHandle,type NativeFinishCutTrackProps} from './NativeFinishCutTrack';
import {NativeTimeline} from './NativeTimeline';
import {buildFinishDisplayMap} from './finishDisplayMap';
import {CutTrack} from '../timeline/CutTrack';
import type {SequenceDocument} from '../../core/sequence/model';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
const {film,wave}=vi.hoisted(()=>({film:vi.fn(()=>[]),wave:vi.fn(()=>({samples:null,failed:false}))}));
vi.mock('../timeline/useFilmstrip',()=>({useFilmstrip:film,STRIP_THUMB_PX:80}));
vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:wave}));
beforeEach(()=>{
 vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit){super(type,init);this.pointerId=init.pointerId??1;}});
 vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));vi.stubGlobal('cancelAnimationFrame',vi.fn());
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
 HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>false;
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);film.mockClear();wave.mockClear();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('restores a directly brushed interior and leaves two non-destructive bands with caption content',async()=>{
 const h=setup(),band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:132+70*2,clientY:40});h.move(80);h.up(80);
 expect(h.onCommand).not.toHaveBeenCalled();expect(h.view.getByLabelText('戻すカット範囲')).toBeTruthy();
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
 const operation=h.onCommand.mock.calls[0]![0];expect(operation).toMatchObject({type:'batch',commands:[{type:'restore-cut',range:{startFrame:10,endFrame:20}}]});
 const after=applySequenceCommand(h.props.document,operation);
 expect(after.sequenceEndFrame).toBe(160);expect(buildFinishDisplayMap(after).cuts.map(c=>[c.start,c.end])).toEqual([[60,70],[80,90]]);
 expect(after.cutArchive!.entries.flatMap(e=>e.clips).every(c=>c.content.kind==='telop'&&c.content.data.text==='本文')).toBe(true);
});
it('click restores the entire saved band without opening the property panel',async()=>{
 const h=setup();fireEvent.click(h.view.container.querySelector('.tl-cut')!);
 await act(async()=>{await h.ref.current!.restore();});
 const after=applySequenceCommand(h.props.document,h.onCommand.mock.calls[0]![0]);expect(after.sequenceEndFrame).toBe(180);expect(after.cutArchive).toBeUndefined();
});
it('does not select the whole band from the trailing click of a boundary handle',async()=>{
 const h=setup();h.down('start');h.up(60);fireEvent.click(h.handle('start'),{clientX:252,clientY:40});
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
});
it('allows a new click on a minimum-width band after the previous brush was cancelled',async()=>{
 const h=setup(),band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:272,clientY:40});h.move(80);fireEvent.keyDown(window,{key:'Escape'});
 h.props.zoom=.01;h.refresh();
 // At this zoom the displayed minimum-width band extends beyond its mapped frames.
 fireEvent.pointerDown(band,{button:0,pointerId:8,clientX:133.5,clientY:40});fireEvent.pointerUp(window,{pointerId:8,clientX:133.5,clientY:40});fireEvent.click(band,{clientX:133.5,clientY:40});
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
 expect(h.onCommand.mock.calls[0]![0]).toMatchObject({type:'batch',commands:[{type:'restore-cut',range:{startFrame:0,endFrame:30}}]});
});
it('rechecks the saved revision after preparing an interior restore and never sends it twice',async()=>{
 const h=setup();let release!:(ok:boolean)=>void;h.props.prepare=()=>new Promise(resolve=>{release=resolve;});h.refresh();
 fireEvent.pointerDown(h.view.container.querySelector('.tl-cut')!,{button:0,pointerId:7,clientX:272,clientY:40});h.move(80);h.up(80);
 let task!:Promise<boolean>;act(()=>{task=h.ref.current!.restore();});await waitFor(()=>expect(release).toBeTypeOf('function'));
 expect(await h.ref.current!.restore()).toBe(false);
 h.props.document={...h.props.document,revision:h.props.document.revision+1};h.refresh();
 await act(async()=>{release(true);expect(await task).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
 h.props.prepare=undefined;h.refresh();await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
 expect(h.onCommand.mock.calls[0]![0]).toMatchObject({type:'batch',commands:[{type:'restore-cut',range:{startFrame:10,endFrame:20}}]});
});
it('retires a finished partial selection when its saved content changes instead of restoring the whole band',async()=>{
 const h=setup();fireEvent.pointerDown(h.view.container.querySelector('.tl-cut')!,{button:0,pointerId:7,clientX:272,clientY:40});h.move(80);h.up(80);
 h.props.document=structuredClone(h.props.document);h.props.document.revision++;
 const c=h.props.document.cutArchive!.entries[0]!.clips[0]!;if(c.content.kind!=='telop')throw new Error('fixture');c.content.data.text='別の字幕';h.refresh();
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
 const band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:272,clientY:40});h.up(70);fireEvent.click(band,{clientX:272,clientY:40});
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
});
it.each(['revision','session','busy','Escape','pointercancel'])('does not apply a stale or cancelled interior after %s',async(kind)=>{
 const h=setup();fireEvent.pointerDown(h.view.container.querySelector('.tl-cut')!,{button:0,pointerId:7,clientX:272,clientY:40});h.move(80);
 if(kind==='Escape')fireEvent.keyDown(window,{key:'Escape'});else if(kind==='pointercancel')fireEvent.pointerCancel(window,{pointerId:7});
 else {if(kind==='revision')h.props.document={...h.props.document,revision:h.props.document.revision+1};if(kind==='session')h.props.sessionId='new';if(kind==='busy')h.props.busy=true;h.refresh();}
 h.up(80);expect(h.onCommand).not.toHaveBeenCalled();expect(h.view.queryByLabelText('戻すカット範囲')).toBeNull();
});
it('maps joined saved entries right to left and restores them through the same core batch',()=>{
 let d=fixture();d=applySequenceCommand(d,{type:'ripple-delete',startFrame:60,endFrame:75});
 const map=buildFinishDisplayMap(d);expect(map.cuts).toHaveLength(1);
 const commands=finishRestoreCommands(map,65,100);expect(commands.length).toBeGreaterThan(1);
 const after=applySequenceCommand(d,{type:'batch',commands});expect(after.sequenceEndFrame).toBe(d.sequenceEndFrame+35);
 expect(buildFinishDisplayMap(after).cuts.map(c=>[c.start,c.end])).toEqual([[60,65],[100,105]]);
});
it('does not authorize restoration from an automatic or persisted active cut alone',async()=>{
 const enabled=vi.fn(),h=setup({onRestoreSelection:enabled});
 expect(enabled).toHaveBeenLastCalledWith(false);
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
});
it('selects the whole band from pointerdown/up even when capture suppresses the click event',async()=>{
 const h=setup(),band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:272,clientY:40});h.up(70);
 expect(h.view.getByLabelText('戻すカット範囲')).toBeTruthy();
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
 expect(h.onCommand.mock.calls[0]![0]).toMatchObject({type:'batch',commands:[{type:'restore-cut',range:{startFrame:0,endFrame:30}}]});
});
it('does not widen a short moved brush when the legacy cut emits its following click',async()=>{
 const h=setup(),band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:272,clientY:40});h.move(72);h.up(72);fireEvent.click(band,{clientX:276,clientY:40});
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(true);});
 expect(h.onCommand.mock.calls[0]![0]).toMatchObject({type:'batch',commands:[{type:'restore-cut',range:{startFrame:10,endFrame:12}}]});
});
it('does not restore from the old explicit selection after remounting another mode or session',async()=>{
 const h=setup();fireEvent.click(h.view.container.querySelector('.tl-cut')!);
 h.props.mode='edit';h.refresh();h.props.mode='finish';h.refresh();
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
});
it('does not turn a cancelled pointer gesture into a full selection through its trailing click',async()=>{
 const h=setup(),band=h.view.container.querySelector('.tl-cut')!;
 fireEvent.pointerDown(band,{button:0,pointerId:7,clientX:272,clientY:40});h.move(72);fireEvent.keyDown(window,{key:'Escape'});h.up(72);fireEvent.click(band,{clientX:276,clientY:40});
 await act(async()=>{expect(await h.ref.current!.restore()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
});
it('does not submit a prepared restore after focus moves to a different live target',async()=>{
 const h=setup();fireEvent.click(h.view.container.querySelector('.tl-cut')!);
 let release!:(value:boolean)=>void;h.props.prepare=()=>new Promise(resolve=>{release=resolve;});h.refresh();
 let task!:Promise<boolean>;act(()=>{task=h.ref.current!.restore();});await waitFor(()=>expect(release).toBeTypeOf('function'));
 h.props.activeCutId=null;h.refresh();await act(async()=>{release(true);expect(await task).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
});
function fixture():SequenceDocument{
 const d:SequenceDocument={schemaVersion:2,id:'p',name:'row',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',assets:[],tracks:[{id:'t',name:'字幕',kind:'visual',enabled:true}],clips:[{id:'caption',name:'本文',trackId:'t',startFrame:0,durationFrames:180,clock:{offset:r(0),rate:r(1),duration:r(180)},content:{kind:'telop',data:{text:'本文'}}}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};
 return applySequenceCommand(d,{type:'ripple-delete',startFrame:60,endFrame:90});
}
function setup(overrides:Partial<NativeFinishCutTrackProps>={}){
 const doc=overrides.document??fixture(),scroller=createRef<HTMLDivElement>(),ref=createRef<NativeFinishCutTrackHandle>();
 const onCommand=vi.fn<NativeFinishCutTrackProps['onCommand']>(async()=>true),select=vi.fn();
 const props:NativeFinishCutTrackProps={projectId:'p',sessionId:'s',document:doc,map:buildFinishDisplayMap(doc),zoom:2,activeCutId:doc.cutArchive!.entries[0]!.id,busy:false,mode:'finish',scroller,onSelectCut:select,onCommand,...overrides};
 const element=()=> <div ref={scroller}><NativeFinishCutTrack {...props} ref={ref}/></div>;
 const view=render(element());
 vi.spyOn(scroller.current!,'getBoundingClientRect').mockReturnValue({left:0,right:500,top:0,bottom:100,width:500,height:100,x:0,y:0,toJSON:()=>({})});
 Object.defineProperty(scroller.current!,'clientWidth',{value:500});Object.defineProperty(scroller.current!,'scrollWidth',{value:2000});
 const handle=(edge:'start'|'end')=>view.getByRole('slider',{name:edge==='start'?'カット左端':'カット右端'});
 const down=(edge:'start'|'end',offset=0)=>fireEvent.pointerDown(handle(edge),{button:0,pointerId:7,clientX:132+(edge==='start'?60:90)*props.zoom+offset,clientY:40});
 const move=(at:number)=>fireEvent.pointerMove(window,{pointerId:7,clientX:132+at*props.zoom,clientY:40});
 const up=(at:number)=>fireEvent.pointerUp(window,{pointerId:7,clientX:132+at*props.zoom,clientY:40});
 return {props,view,scroller,ref,handle,down,move,up,onCommand,select,refresh:()=>view.rerender(element())};
}
it('reuses the legacy cut and handle DOM at native 132px, without fake single-source decoding',()=>{
 const h=setup();const cut=h.view.container.querySelector('.tl-cut') as HTMLElement;
 expect(cut.style.left).toBe('252px');expect(cut.style.width).toBe('60px');expect(h.handle('start').tagName).toBe('DIV');expect(h.handle('start').style.width).toBe('10px');
 expect((h.view.container.querySelector('.tl-track-cut') as HTMLElement).style.getPropertyValue('--track-label-w')).toBe('132px');expect(film).toHaveBeenCalledWith(null,180,expect.any(Number));expect(wave).toHaveBeenCalledWith(null);
 fireEvent.click(cut);expect(h.select).toHaveBeenCalledWith(h.props.activeCutId);expect(h.onCommand).not.toHaveBeenCalled();
});
it('retains the old 88px default, empty hint and hidden narrow handles for legacy callers',()=>{
 const v=render(<CutTrack totalFrames={100} pxPerFrame={1} cutRegions={[{start:10,end:12}]} liveRegions={null} selectedHandle={null} onHandleDown={()=>{}} pulseKeys={new Set()} videoUrl=""/>);
 expect((v.container.querySelector('.tl-cut') as HTMLElement).style.left).toBe('98px');expect((v.container.querySelector('.tl-handle') as HTMLElement).style.display).toBe('none');
});
it.each([['start',50,'live',50],['end',100,'live',70],['start',70,'archived',10],['end',80,'archived',20]] as const)('maps %s to %s and commits once only on release',async(edge,at,kind,frame)=>{
 const h=setup();h.down(edge);h.move(at);expect(h.onCommand).not.toHaveBeenCalled();h.up(at);h.up(at);
 await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));const call=h.onCommand.mock.calls[0]!;expect(call[0]).toMatchObject({type:'resize-cut-boundary',edge,target:kind==='live'?{kind,frame}:{kind,localFrame:frame}});expect(call[1]).toEqual({documentId:'p',revision:h.props.document.revision});
 expect(()=>applySequenceCommand(h.props.document,call[0])).not.toThrow();
});
it('preserves grab offset and removes the ghost if the pointer returns to its original boundary',async()=>{
 const h=setup();h.down('start',-4);h.move(48);expect(h.handle('start').getAttribute('aria-valuenow')).toBe('50');h.up(48);await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));
 h.down('start');h.move(70);h.move(60);expect(h.handle('start').getAttribute('aria-valuenow')).toBe('60');h.up(60);expect(h.onCommand).toHaveBeenCalledTimes(1);
});
it.each(['Escape','pointercancel','lostpointercapture','blur','revision','mode','zoom','busy','session'])('retires the drag on %s without later mouseup committing',kind=>{
 const h=setup();h.down('start');h.move(70);
 if(kind==='Escape')fireEvent.keyDown(window,{key:'Escape'});else if(kind==='pointercancel')fireEvent.pointerCancel(window,{pointerId:7});else if(kind==='lostpointercapture')fireEvent.lostPointerCapture(h.handle('start'),{pointerId:7});else if(kind==='blur')fireEvent.blur(window);
 else {if(kind==='revision')h.props.document={...h.props.document,revision:h.props.document.revision+1};if(kind==='mode')h.props.mode='edit';if(kind==='zoom')h.props.zoom=3;if(kind==='busy')h.props.busy=true;if(kind==='session')h.props.sessionId='other';h.refresh();}
 h.up(70);expect(h.onCommand).not.toHaveBeenCalled();expect(h.handle('start').getAttribute('aria-valuenow')).toBe('60');
});
it('ignores another pointer and leaves a pure click unchanged',()=>{
 const h=setup();h.down('start');fireEvent.pointerMove(window,{pointerId:8,clientX:400,clientY:40});fireEvent.pointerUp(window,{pointerId:8,clientX:400,clientY:40});h.up(60);expect(h.onCommand).not.toHaveBeenCalled();
});
it('recalculates the same pointer after scroll and scrolls only after confirmed movement',async()=>{
 const h=setup();h.down('start');h.scroller.current!.scrollLeft=8;fireEvent.scroll(h.scroller.current!);expect(h.handle('start').getAttribute('aria-valuenow')).toBe('60');
 h.move(70);h.scroller.current!.scrollLeft=18;fireEvent.scroll(h.scroller.current!);expect(h.handle('start').getAttribute('aria-valuenow')).toBe('79');h.up(70);
 await waitFor(()=>expect(h.onCommand).toHaveBeenCalledWith(expect.objectContaining({target:expect.objectContaining({localFrame:19})}),expect.anything()));
});
it('supports both narrow handles from the keyboard without covering their body pointer hit area',async()=>{
 const h=setup({zoom:.1});expect(h.handle('start').style.display).not.toBe('none');expect(h.handle('start').style.pointerEvents).toBe('none');expect(h.handle('start').tabIndex).toBe(0);
 fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));expect(h.onCommand.mock.calls[0]![0]).toMatchObject({target:{kind:'archived',localFrame:1}});
 fireEvent.keyDown(h.handle('end'),{key:'ArrowLeft'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(2));expect(h.onCommand.mock.calls[1]![0]).toMatchObject({target:{kind:'archived',localFrame:29}});
});
it('awaits one pending operation from flush, rejects duplicate input and keeps failure retryable',async()=>{
 const h=setup();let release!:(ok:boolean)=>void;h.onCommand.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));
 fireEvent.keyDown(h.handle('end'),{key:'ArrowLeft'});let settled=false;const flushed=h.ref.current!.flush().then(ok=>{settled=true;return ok;});expect(settled).toBe(false);
 await act(async()=>{release(false);expect(await flushed).toBe(false);});expect(h.view.getByRole('alert').textContent).toContain('変更できません');expect(h.onCommand).toHaveBeenCalledTimes(1);
 fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(2));
});
it('refuses a stale prepared target without calling the command and ignores a retired completion',async()=>{
 const h=setup();let done!:()=>void;h.props.prepare=()=>new Promise(resolve=>{done=()=>resolve(true);});h.refresh();fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(done).toBeTypeOf('function'));
 h.props.document={...h.props.document,revision:h.props.document.revision+1};h.refresh();await act(async()=>{done();expect(await h.ref.current!.flush()).toBe(false);});expect(h.onCommand).not.toHaveBeenCalled();
 h.props.prepare=undefined;let release!:(ok:boolean)=>void;h.onCommand.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));h.refresh();fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));h.props.sessionId='new';h.refresh();await act(async()=>{release(false);});expect(h.view.queryByRole('alert')).toBeNull();
});
it('does not use remote, unrelated or ambiguous owners to widen a cut',()=>{
 const h=setup(),cut=h.props.map.cuts[0]!;
 expect(()=>finishCutTarget(h.props,cut,'start',-1)).toThrow();expect(()=>finishCutTarget(h.props,cut,'start',100)).toThrow();
 const duplicate={...h.props.document.clips[0]!,id:'unlinked'};h.props.document={...h.props.document,clips:[...h.props.document.clips,duplicate]};expect(()=>finishCutTarget(h.props,cut,'start',50)).toThrow('使用箇所');
 expect(finishCutTarget({...h.props,liveOwner:{start:duplicate.id}},cut,'start',50)).toEqual({kind:'live',clipId:'unlinked',frame:50});
});
it('accepts an explicitly linked AV occurrence, while rejecting another same-source overlapping use',()=>{
 const d=fixture();d.tracks=[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true}];
 d.assets=[{id:'media',name:'source',kind:'media',file:'source.mp4',fingerprint:'test',streams:[{kind:'video',index:0,codec:'h264',width:320,height:180,frameRate:r(30),duration:r(10)},{kind:'audio',index:1,codec:'aac',sampleRate:48000,channels:2,duration:r(10)}]}];
 d.clips=d.clips.flatMap(c=>[
  {...c,id:c.id+'-video',trackId:'v',linkGroupId:c.id+'-av',content:{kind:'video' as const,assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}},
  {...c,id:c.id+'-audio',trackId:'a',linkGroupId:c.id+'-av',content:{kind:'audio' as const,assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech' as const,loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
 ]);
 // Rebind the known cut seam to the renamed live occurrences for this AV fixture.
 d.cutArchive!.entries[0]!.boundary={hintFrame:60,ambiguous:false,references:d.clips.map(c=>({clipId:c.id,edge:c.startFrame===0?'end' as const:'start' as const,offsetFrames:0}))};
 const map=buildFinishDisplayMap(d),cut=map.cuts[0]!;
 const target=finishCutTarget({document:d,map},cut,'start',50);expect(target).toMatchObject({kind:'live',frame:50,clipId:d.clips[0]!.id});
 expect(applySequenceCommand(d,{type:'resize-cut-boundary',cut:cut.cut,edge:'start',target}).sequenceEndFrame).toBe(140);
 const extra={...d.clips[0]!,id:'different-use',linkGroupId:'another-av'};d.clips.push(extra);expect(()=>finishCutTarget({document:d,map},cut,'start',50)).toThrow('使用箇所');
});
/** The row owns no rAF loop of its own; the shared parent loop in
 * useNativeTimelineViewport does the scrolling. So the contract that matters is
 * measured end to end: drag the cut row inside a real NativeTimeline and read scrollLeft. */
function inTimeline(extra:Record<string,unknown>={}){
 const frames=new Map<number,FrameRequestCallback>();let serial=0;
 vi.mocked(requestAnimationFrame).mockImplementation(fn=>{frames.set(++serial,fn);return serial;});
 vi.mocked(cancelAnimationFrame).mockImplementation(id=>{frames.delete(id);});
 const doc=fixture(),onCommand=vi.fn(async()=>true);
 const props={projectId:'p',sessionId:'s',document:doc,waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:2,snap:false,mode:'finish',
  activeCutId:doc.cutArchive!.entries[0]!.id,onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand,onSelectCut:vi.fn(),...extra};
 const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
 Object.defineProperties(scroller,{clientWidth:{configurable:true,value:500},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:2000}});
 scroller.getBoundingClientRect=()=>({left:0,right:500,top:0,bottom:300,width:500,height:300,x:0,y:0,toJSON(){}});
 const handle=(edge:'start'|'end')=>ui.getByRole('slider',{name:edge==='start'?'カット左端':'カット右端'});
 return {ui,scroller,handle,onCommand,frames,
  tick:(time:number)=>act(()=>{const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(time));}),
  down:(edge:'start'|'end')=>fireEvent.pointerDown(handle(edge),{button:0,buttons:1,pointerId:7,clientX:132+(edge==='start'?60:90)*2,clientY:40}),
  move:(x:number)=>fireEvent.pointerMove(window,{buttons:1,pointerId:7,clientX:x,clientY:40})};
}
it('keeps the finish cut row scrolling from the shared loop while the pointer rests at the right edge',()=>{
 const t=inTimeline();
 t.down('end');t.tick(0);expect(t.scroller.scrollLeft).toBe(0);
 t.move(495);t.tick(16);
 const first=t.scroller.scrollLeft;expect(first).toBeGreaterThan(0);
 t.tick(32);expect(t.scroller.scrollLeft).toBeGreaterThan(first);   // 静止したままでも流れ続ける
 expect(t.onCommand).not.toHaveBeenCalled();
});
it('scrolls the finish cut row left at the left edge, measured from the label gutter',()=>{
 const t=inTimeline();t.scroller.scrollLeft=80;
 t.down('start');t.move(150);t.tick(16);
 // 132px の見出し幅が左端。bounds.left(0) を基準にすると 150px は端ゾーンの外で、一切動かない。
 expect(t.scroller.scrollLeft).toBeLessThan(80);
 expect(t.onCommand).not.toHaveBeenCalled();
});
it('stops the shared loop for the finish cut row once the drag is cancelled',()=>{
 const t=inTimeline();
 t.down('end');t.move(495);t.tick(16);expect(t.scroller.scrollLeft).toBeGreaterThan(0);
 fireEvent.keyDown(window,{key:'Escape'});
 const parked=t.scroller.scrollLeft;t.tick(32);t.tick(48);
 expect(t.scroller.scrollLeft).toBe(parked);expect(t.onCommand).not.toHaveBeenCalled();
});
it('reports a finish cut row drag upward as a timeline drag, so the preview stops taking hits',()=>{
 const onDragStateChange=vi.fn();
 const t=inTimeline({onDragStateChange});
 t.down('end');expect(onDragStateChange).toHaveBeenLastCalledWith(true);
 fireEvent.keyDown(window,{key:'Escape'});expect(onDragStateChange).toHaveBeenLastCalledWith(false);
});
it('reports the finish cut drag as finished when the row unmounts mid-gesture',()=>{
 const onDragStateChange=vi.fn();
 const h=setup({onDragStateChange});h.down('end');
 expect(onDragStateChange).toHaveBeenLastCalledWith(expect.objectContaining({dragging:true}));
 h.view.unmount();
 expect(onDragStateChange).toHaveBeenLastCalledWith(expect.objectContaining({dragging:false}));
});
it('allows full group restoration from either archived endpoint and never crosses a different cut',()=>{
 let d=fixture(),id=d.cutArchive!.entries[0]!.id;
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:{kind:'entry',id},edge:'start',target:{kind:'live',clipId:d.clips[0]!.id,frame:50}});
 const map=buildFinishDisplayMap(d),group=map.cuts[0]!;
 for(const [edge,at] of [['start',group.end],['end',group.start]] as const){const target=finishCutTarget({document:d,map},group,edge,at);const restored=applySequenceCommand(d,{type:'resize-cut-boundary',cut:group.cut,edge,target});expect(restored.cutArchive?.entries??[]).toEqual([]);expect(restored.sequenceEndFrame).toBe(180);}
 d=applySequenceCommand(d,{type:'ripple-delete',startFrame:100,endFrame:110});const both=buildFinishDisplayMap(d);expect(()=>finishCutTarget({document:d,map:both},both.cuts[0]!,'end',both.cuts[1]!.start+1)).toThrow('別の保存帯');
});
it('cancels on unmount while retaining the command result for an already waiting flush caller',async()=>{
 const h=setup();let release!:(ok:boolean)=>void;h.onCommand.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.onCommand).toHaveBeenCalledTimes(1));const waiting=h.ref.current!.flush();h.view.unmount();release(true);expect(await waiting).toBe(true);
});
it('flush cancels an uncommitted gesture, and a rejected preparation does not invoke the command',async()=>{
 const h=setup();h.down('start');h.move(70);await act(async()=>{expect(await h.ref.current!.flush()).toBe(true);});h.up(70);expect(h.onCommand).not.toHaveBeenCalled();
 h.props.prepare=async()=>false;h.refresh();fireEvent.keyDown(h.handle('start'),{key:'ArrowRight'});await waitFor(()=>expect(h.view.getByRole('alert')).toBeTruthy());expect(h.onCommand).not.toHaveBeenCalled();
});
it('distinguishes an unresolved saved cut from an empty archive without drawing a guessed band',()=>{
 const d=fixture();d.cutArchive!.entries[0]!.boundary.ambiguous=true;const h=setup({document:d});
 expect(h.view.queryByText('保存されたカットはありません')).toBeNull();expect(h.view.getByText('位置を確認するカットがあります')).toBeTruthy();expect(h.view.container.querySelector('.tl-cut')).toBeNull();
});
