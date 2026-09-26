/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
const state=vi.hoisted(()=>({flush:vi.fn(),resolve:vi.fn(),reference:vi.fn(),upload:vi.fn()}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:state.flush}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:state.resolve,cancel(){},picker:null})}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
 schemaVersion:2,id:'ownership',revision:0,name:'ownership',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
 background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false,reference:state.reference,upload:state.upload})}));
beforeEach(()=>{
 Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:()=>'/media/source.mp4'}});
 sessionStorage.clear();state.flush.mockReset();state.resolve.mockReset().mockResolvedValue({path:'/media/source.mp4',expectedFingerprint:'a'.repeat(64)});state.reference.mockReset().mockResolvedValue(true);state.upload.mockReset().mockResolvedValue(true);
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})})));
});
afterEach(()=>{cleanup();Reflect.deleteProperty(window,'harnessDesktop');vi.unstubAllGlobals();});
it('imports all browser drops directly without a location picker',async()=>{
 Reflect.deleteProperty(window,'harnessDesktop');state.flush.mockResolvedValue(true);
 const view=render(<NativeWorkspace projectId="ownership"/>),files=[new File(['a'],'first.mp4'),new File(['b'],'second.mp4')];
 fireEvent.drop(view.container.querySelector('.native-library')!,{dataTransfer:{files}});
 await waitFor(()=>expect(state.upload).toHaveBeenCalledTimes(2));
 expect(state.upload.mock.calls.map(call=>call[0])).toEqual(files);expect(state.resolve).not.toHaveBeenCalled();
});
it.each(['reference','copy','music'])('does not start a %s import after leaving during the input flush',async kind=>{
 let finish!:(ok:boolean)=>void;state.flush.mockImplementation(()=>new Promise<boolean>(r=>{finish=r;}));
 const view=render(<NativeWorkspace projectId="ownership"/>),file=new File(['media'],'source.mp4');
 if(kind==='reference')fireEvent.drop(view.container.querySelector('.native-library')!,{dataTransfer:{files:[file]}});
 else{const input=kind==='music'?view.getByLabelText('BGM・効果音ファイル'):view.container.querySelector('input[multiple]')!;fireEvent.change(input,{target:{files:[file]}});}
 await waitFor(()=>expect(state.flush).toHaveBeenCalled());view.unmount();await act(async()=>{finish(true);});
 expect(state.resolve).not.toHaveBeenCalled();expect(state.reference).not.toHaveBeenCalled();expect(state.upload).not.toHaveBeenCalled();
});
it('imports a dropped file after the current project finishes its flush',async()=>{
 state.flush.mockResolvedValue(true);const view=render(<NativeWorkspace projectId="ownership"/>),file=new File(['media'],'source.mp4');
 fireEvent.drop(view.container.querySelector('.native-library')!,{dataTransfer:{files:[file]}});
 await waitFor(()=>expect(state.reference).toHaveBeenCalledWith('/media/source.mp4','a'.repeat(64),expect.any(Function),undefined));expect(state.upload).not.toHaveBeenCalled();
});
it('does not register a location resolved just after the project was retired',async()=>{
 state.flush.mockResolvedValue(true);let finish!:(value:{path:string;expectedFingerprint:string})=>void;state.resolve.mockImplementation(()=>new Promise(r=>{finish=r;}));
 const view=render(<NativeWorkspace projectId="ownership"/>),file=new File(['media'],'source.mp4');fireEvent.drop(view.container.querySelector('.native-library')!,{dataTransfer:{files:[file]}});
 await waitFor(()=>expect(state.resolve).toHaveBeenCalled());view.unmount();await act(async()=>{finish({path:'/old/source.mp4',expectedFingerprint:'a'.repeat(64)});});
 expect(state.reference).not.toHaveBeenCalled();expect(state.upload).not.toHaveBeenCalled();
});
// B: 「＋ BGM を追加」「＋ 効果音を追加」は、押したタブの role を取り込み API まで届けなければならない
// （届かないと origin.role が残らず、次に開いた時この素材が分類規則 7 の当て推量へ落ちる）。
it.each([['BGM','＋ BGM を追加','music'],['効果音','＋ 効果音を追加','effect']] as const)('passes the %s tab role through to the import',async(tab,button,role)=>{
 state.flush.mockResolvedValue(true);
 const view=render(<NativeWorkspace projectId="ownership"/>),file=new File(['media'],'theme.mp3');
 fireEvent.click(view.getByRole('tab',{name:'素材'}));
 fireEvent.click(await view.findByRole('tab',{name:`${tab} 0`}));
 fireEvent.click(await view.findByRole('button',{name:button}));
 fireEvent.change(view.getByLabelText('BGM・効果音ファイル'),{target:{files:[file]}});
 await waitFor(()=>expect(state.reference).toHaveBeenCalledWith('/media/source.mp4','a'.repeat(64),expect.any(Function),role));
});
