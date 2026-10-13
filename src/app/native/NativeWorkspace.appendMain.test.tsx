/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
const h=vi.hoisted(()=>({append:vi.fn(),upload:vi.fn(),execute:vi.fn(),busy:false,timeline:null as null|{onDrop(assetId:string,frame:number,trackId:string):void;onRange(range:unknown):void;range:unknown}}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((props:{onDrop(assetId:string,frame:number,trackId:string):void;onRange(range:unknown):void;range:unknown},_ref)=>{h.timeline=props;return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:vi.fn(),cancel(){},picker:null})}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>{
  const r=(n:number)=>({num:n,den:1});
  const media=(id:string,kinds:Array<'video'|'audio'>)=>({id,kind:'media',file:`.harness/assets/${id}.mp4`,name:`${id}.mp4`,fingerprint:id.padEnd(64,'0'),
    streams:kinds.map((kind,index)=>kind==='video'?{index,kind,codec:'h264',duration:r(1),frameRate:r(30),width:160,height:90}:{index,kind,codec:'aac',duration:r(1),sampleRate:48000,channels:2})});
  const state={sessionId:'s',dirty:false,document:{schemaVersion:2,id:'p1',revision:0,name:'p1',fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
    assets:[media('movie',['video','audio']),media('song',['audio'])],tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true}],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}}};
  return {useNativeSession:()=>({state,busy:h.busy,reference:vi.fn(),upload:h.upload,execute:h.execute,readCurrent:()=>state,accept:vi.fn(),appendToMain:h.append})};
});
beforeEach(()=>{
  Reflect.deleteProperty(window,'harnessDesktop');sessionStorage.clear();localStorage.clear();h.busy=false;h.timeline=null;
  h.append.mockReset().mockResolvedValue({ok:true});h.execute.mockReset().mockResolvedValue(true);
  h.upload.mockReset().mockImplementation(async(file:File,_progress:unknown,onUploaded?:(id:string)=>void)=>{onUploaded?.(`id-${file.name}`);return true;});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows 「メインの末尾に追加」 only for video assets and sends that asset',async()=>{
  const view=render(<NativeWorkspace projectId="p1"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));
  const button=await view.findByRole('button',{name:'movie.mp4をメインの末尾に追加'});
  expect(view.queryByRole('button',{name:'song.mp4をメインの末尾に追加'})).toBeNull();
  fireEvent.click(button);await waitFor(()=>expect(h.append).toHaveBeenCalledWith(['movie']));
});
it('disables the button while editing is locked',async()=>{
  h.busy=true;const view=render(<NativeWorkspace projectId="p1"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));
  expect((await view.findByRole('button',{name:'movie.mp4をメインの末尾に追加'}) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps a timeline drop at the dropped frame and track (not the main end)',async()=>{
  render(<NativeWorkspace projectId="p1"/>);await waitFor(()=>expect(h.timeline).not.toBeNull());
  h.timeline!.onDrop('movie',120,'v-main');
  await waitFor(()=>expect(h.execute).toHaveBeenCalled());
  const command=h.execute.mock.calls[0]![0] as {type:string;commands:Array<{type:string;clips?:Array<{startFrame:number}>}>};
  expect(command.type).toBe('batch');expect(command.commands.find(c=>c.type==='insert')!.clips![0]!.startFrame).toBe(120);
  expect(h.append).not.toHaveBeenCalled();
});
it('clears the range selection after appending to the main end, and keeps it when the append was refused',async()=>{
  const view=render(<NativeWorkspace projectId="p1"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));
  await waitFor(()=>expect(h.timeline).not.toBeNull());
  const range={trackId:'v-main',startFrame:10,endFrame:20};
  act(()=>{h.timeline!.onRange(range);});expect(h.timeline!.range).toEqual(range);
  h.append.mockResolvedValueOnce({ok:false,message:'速度を設定した案件では、まだメインに素材を足せません。'});
  fireEvent.click(await view.findByRole('button',{name:'movie.mp4をメインの末尾に追加'}));await waitFor(()=>expect(h.append).toHaveBeenCalledTimes(1));
  await act(async()=>{});expect(h.timeline!.range).toEqual(range);
  fireEvent.click(await view.findByRole('button',{name:'movie.mp4をメインの末尾に追加'}));await waitFor(()=>expect(h.append).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(h.timeline!.range).toBeNull());
});
