/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle,useRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import {applySequenceCommand} from '../../core/sequence/commands';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
const state=vi.hoisted(()=>({doc:null as unknown as SequenceDocument,execute:vi.fn(async()=>true)}));
const scrollDescriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView');
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:any,ref)=>{
 useImperativeHandle(ref,()=>({pause(){},seek(){},seekBy(){},flushManipulation:async()=>true}));return <output data-testid="preview-selection">{JSON.stringify(props.manipulation?.selected??[])}</output>;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeCaptionPanel',()=>({NativeCaptionPanel:forwardRef((props:any,ref)=>{
 useImperativeHandle(ref,()=>({flush:async()=>true}));return <><button onClick={()=>props.onSelect('caption',10)}>choose caption</button><button onClick={()=>props.onStyle('caption')}>style caption</button></>;
})}));
vi.mock('./NativeTimeline',async()=>{
 const {NativeFinishCutTrack}=await import('./NativeFinishCutTrack');const {buildFinishDisplayMap}=await import('./finishDisplayMap');
 return {NativeTimeline:forwardRef((props:any,ref)=>{
  const row=useRef<any>(null),scroller=useRef<HTMLDivElement>(null);
  useImperativeHandle(ref,()=>({flush:()=>row.current?.flush()??Promise.resolve(true),restoreCut:()=>row.current?.restore()??Promise.resolve(false)}));
  return <div ref={scroller}><output data-testid="selection">{JSON.stringify({active:props.activeCutId,selected:props.selected,range:props.range})}</output><button onClick={()=>props.onRange({startFrame:10,endFrame:20,trackId:null})}>live range</button>
   {props.mode==='finish'&&<NativeFinishCutTrack ref={row} projectId={props.projectId} document={props.document} map={buildFinishDisplayMap(props.document)} zoom={2} scroller={scroller} activeCutId={props.activeCutId} busy={props.busy} mode={props.mode} sessionId={props.sessionId} onSelectCut={props.onSelectCut} onCommand={props.onCutCommand} onRestoreSelection={props.onRestoreSelection}/>}
  </div>;
 })};
});
vi.mock('../timeline/useFilmstrip',()=>({useFilmstrip:()=>[],STRIP_THUMB_PX:80}));
vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:()=>({samples:null,failed:false})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'s',dirty:false,document:state.doc},busy:false,execute:state.execute,readCurrent:()=>({document:state.doc})})}));
beforeEach(()=>{
 // jsdom has no layout scrolling; actual cut reveal is verified in the browser.
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
 state.execute.mockClear();sessionStorage.clear();
 const clock={offset:r(0),rate:r(1),duration:r(180)};
 const doc:SequenceDocument={schemaVersion:2,id:'selection',name:'selection',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',tracks:[{id:'c',name:'字幕',kind:'visual',enabled:true},{id:'a',name:'原音',kind:'audio',enabled:true}],assets:[{id:'asset',name:'source',file:'source.wav',kind:'media',fingerprint:'a'.repeat(64),streams:[{kind:'audio',index:0,codec:'pcm_s16le',sampleRate:48000,channels:2,duration:r(2)}]}],clips:[
 {id:'caption',name:'caption',trackId:'c',startFrame:0,durationFrames:180,clock,content:{kind:'telop',data:{text:'本文'}}},
 {id:'speech',name:'speech',trackId:'a',startFrame:0,durationFrames:60,clock,content:{kind:'audio',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transcripts:[{assetId:'asset',streamIndex:0,words:[{id:'word',text:'確認する語',start:r(1,3),end:r(2,3)}]}],transitions:[],ducking:{enabled:false,strength:'mid'}};
 state.doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:60,endFrame:90});
 sessionStorage.setItem('harness-native-view:selection',JSON.stringify({mode:'finish',tab:'transcript',activeCutId:state.doc.cutArchive!.entries[0]!.id}));
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();if(scrollDescriptor)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',scrollDescriptor);else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');});
it('does not expose a restore action from a persisted active cut',async()=>{
 const v=render(<NativeWorkspace projectId="selection"/>);expect(v.queryByText('選択範囲を戻す')).toBeNull();
 fireEvent.keyDown(document.body,{key:'Delete'});await act(async()=>{});expect(state.execute).not.toHaveBeenCalled();
});
it.each(['choose caption','style caption','live range','確認する語'])('retires an explicit cut choice when selecting %s',async label=>{
 const v=render(<NativeWorkspace projectId="selection"/>);fireEvent.click(v.container.querySelector('.tl-cut')!);await waitFor(()=>expect(v.getByText('選択範囲を戻す')).toBeTruthy());
 if(label!=='live range'){fireEvent.click(v.getByRole('tab',{name:'字幕一覧'}));await waitFor(()=>expect(v.getByText(label)).toBeTruthy());}
 fireEvent.click(v.getByText(label));await waitFor(()=>expect(JSON.parse(v.getByTestId('selection').textContent!).active).toBeNull());
 expect(v.queryByText('選択範囲を戻す')).toBeNull();expect(JSON.parse(v.getByTestId('preview-selection').textContent!)).toEqual(JSON.parse(v.getByTestId('selection').textContent!).selected);fireEvent.keyDown(document.body,{key:'Delete'});
 await waitFor(()=>expect(state.execute).toHaveBeenCalledOnce());expect(state.execute.mock.calls[0]).toEqual([label==='live range'||label==='確認する語'?{type:'ripple-delete',startFrame:10,endFrame:20}:{type:'delete',clipIds:['caption']}]);
});

it('retires a cut restore selection when the material library takes focus',async()=>{
 const v=render(<NativeWorkspace projectId="selection"/>);fireEvent.click(v.container.querySelector('.tl-cut')!);
 await waitFor(()=>expect(v.getByText('選択範囲を戻す')).toBeTruthy());
 fireEvent.click(v.container.querySelector('.native-asset')!);
 await waitFor(()=>expect(JSON.parse(v.getByTestId('selection').textContent!).active).toBeNull());
 fireEvent.keyDown(document.body,{key:'Delete'});await act(async()=>{});expect(state.execute).not.toHaveBeenCalled();
});
