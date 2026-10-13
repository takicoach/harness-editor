/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
const state=vi.hoisted(()=>({doc:null as unknown as SequenceDocument}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((props:any,ref)=>{
 useImperativeHandle(ref,()=>({pause(){},seek(){},seekBy(){},frame:()=>0,cancelManipulation(){},flushManipulation:async()=>true}));
 return <><button onClick={()=>props.onFrame(0)}>playhead 0</button><button onClick={()=>props.onFrame(90)}>playhead 90</button></>;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef(()=>null)}));
vi.mock('./NativeCaptionPanel',()=>({NativeCaptionPanel:forwardRef(()=>null)}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((props:any)=><><button onClick={()=>props.onSelect(['speech-1'])}>select clip A</button><button onClick={()=>props.onSelect(['speech-2'])}>select clip B</button></>)}));
vi.mock('../timeline/useFilmstrip',()=>({useFilmstrip:()=>[],STRIP_THUMB_PX:80}));
vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:()=>({samples:null,failed:false})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef((props:any)=><output data-testid="script-occurrence">{props.occurrenceId}</output>)}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:(props:any)=><><output data-testid="transcribe-occurrence">{props.occurrenceId}</output><button onClick={()=>props.onEngage?.()}>文字起こしを生成</button></>}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'s',dirty:false,document:state.doc},busy:false,execute:async()=>true,readCurrent:()=>({document:state.doc})})}));

/** メインの原音トラックに別素材の原音が2本（0-60 と 60-120）。それぞれに文字起こしがある。 */
beforeEach(()=>{
 sessionStorage.clear();
 const asset=(id:string)=>({id,name:`${id}.wav`,file:`${id}.wav`,kind:'media' as const,fingerprint:id.padStart(64,'a'),streams:[{kind:'audio' as const,index:0,codec:'pcm_s16le',sampleRate:48000,channels:2,duration:r(2)}]});
 const speech=(id:string,assetId:string,startFrame:number):SequenceClip=>({id,name:id,trackId:'a-main',startFrame,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},
  content:{kind:'audio',assetId,streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}});
 state.doc={schemaVersion:2,id:'speech',name:'speech',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',
  tracks:[{id:'a-main',name:'原音',kind:'audio',enabled:true}],assets:[asset('first'),asset('second')],clips:[speech('speech-1','first',0),speech('speech-2','second',60)],
  transcripts:[{assetId:'first',streamIndex:0,words:[{id:'w1',text:'最初の語',start:r(1,3),end:r(2,3)}]},{assetId:'second',streamIndex:0,words:[{id:'w2',text:'二本目の語',start:r(1,3),end:r(2,3)}]}],
  transitions:[],ducking:{enabled:false,strength:'mid'}};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const transcriptTab=async(v:ReturnType<typeof render>)=>{fireEvent.click(v.getByRole('tab',{name:'字幕一覧'}));await waitFor(()=>expect(v.getByLabelText('発話の使用箇所')).toBeTruthy());};

it('lists the words of the main source under the playhead, marked as automatic',async()=>{
 const v=render(<NativeWorkspace projectId="speech"/>);await transcriptTab(v);
 const select=v.getByLabelText('発話の使用箇所') as HTMLSelectElement;
 expect(select.value).toBe('');expect(select.options[0]!.textContent).toBe('再生位置の原音（自動）');
 expect(v.getByText('最初の語')).toBeTruthy();expect(v.getByTestId('transcribe-occurrence').textContent).toBe('speech-1');
 fireEvent.click(v.getByText('playhead 90'));
 await waitFor(()=>expect(v.getByText('二本目の語')).toBeTruthy());
 expect(v.queryByText('最初の語')).toBeNull();expect(v.getByTestId('transcribe-occurrence').textContent).toBe('speech-2');
});
it('keeps the script matching target still while the playhead moves',async()=>{
 const v=render(<NativeWorkspace projectId="speech"/>);fireEvent.click(v.getByRole('tab',{name:'台本'}));
 await waitFor(()=>expect(v.getByTestId('script-occurrence')).toBeTruthy());
 expect(v.getByTestId('script-occurrence').textContent).toBe('');expect((v.getByLabelText('台本と照合する原音') as HTMLSelectElement).value).toBe('');
 fireEvent.click(v.getByText('playhead 90'));fireEvent.click(v.getByText('playhead 0'));
 fireEvent.change(v.getByLabelText('台本と照合する原音'),{target:{value:'speech-2'}});
 await waitFor(()=>expect(v.getByTestId('script-occurrence').textContent).toBe('speech-2'));
 fireEvent.click(v.getByText('playhead 90'));fireEvent.click(v.getByText('playhead 0'));
 expect(v.getByTestId('script-occurrence').textContent).toBe('speech-2');
});
it('stops following once a word is pressed',async()=>{
 const v=render(<NativeWorkspace projectId="speech"/>);await transcriptTab(v);
 fireEvent.pointerDown(v.getByText('最初の語'));
 fireEvent.click(v.getByText('playhead 90'));
 await waitFor(()=>expect((v.getByLabelText('発話の使用箇所') as HTMLSelectElement).value).toBe('speech-1'));
 expect(v.getByText('最初の語')).toBeTruthy();expect(v.queryByText('二本目の語')).toBeNull();
});
it('stops following once transcription is started',async()=>{
 const v=render(<NativeWorkspace projectId="speech"/>);await transcriptTab(v);
 fireEvent.click(v.getByText('playhead 90'));await waitFor(()=>expect(v.getByTestId('transcribe-occurrence').textContent).toBe('speech-2'));
 fireEvent.click(v.getByRole('button',{name:'文字起こしを生成'}));
 fireEvent.click(v.getByText('playhead 0'));
 await waitFor(()=>expect((v.getByLabelText('発話の使用箇所') as HTMLSelectElement).value).toBe('speech-2'));
 expect(v.getByTestId('transcribe-occurrence').textContent).toBe('speech-2');
});
it('keeps following the timeline selection after a word press when one source is split into two clips (not a following project)',async()=>{
 const doc=state.doc,first=doc.clips[0]!,second=doc.clips[1]!;
 state.doc={...doc,assets:doc.assets.filter(a=>a.id==='first').map(a=>({...a,streams:a.streams.map(st=>({...st,duration:r(4)}))})),
  clips:[first,{...second,content:{...(second.content as Extract<SequenceClip['content'],{kind:'audio'}>),assetId:'first',sourceIn:r(2)}}],
  transcripts:[{assetId:'first',streamIndex:0,words:[{id:'w1',text:'最初の語',start:r(1,3),end:r(2,3)},{id:'w2',text:'後半の語',start:r(7,3),end:r(8,3)}]}]};
 const v=render(<NativeWorkspace projectId="speech"/>);await transcriptTab(v);
 const select=v.getByLabelText('発話の使用箇所') as HTMLSelectElement;
 expect(select.options[0]!.textContent).toBe('原音を選択してください');expect(select.value).toBe('');
 fireEvent.click(v.getByText('select clip A'));
 await waitFor(()=>expect(v.getByText('最初の語')).toBeTruthy());expect(v.queryByText('後半の語')).toBeNull();
 fireEvent.pointerDown(v.getByText('最初の語'));fireEvent.pointerUp(v.getByText('最初の語'));
 fireEvent.click(v.getByText('select clip B'));
 await waitFor(()=>expect((v.getByLabelText('発話の使用箇所') as HTMLSelectElement).value).toBe('speech-2'));
 expect(v.getByText('後半の語')).toBeTruthy();expect(v.queryByText('最初の語')).toBeNull();
});
