/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import {useNativeNavigation} from './useNativeNavigation';

const session=vi.hoisted(()=>({document:null as unknown,error:null as string|null,loading:false,busy:false,save:vi.fn(async()=>false)}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true,restoreCut:async()=>true,fitZoom(){}}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true,blurDraft(){}}));return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false,resumeAutoSave(){}})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({
  state:session.document?{sessionId:'test',dirty:true,document:session.document}:null,
  error:session.error,loading:session.loading,busy:session.busy,save:session.save,
  execute:vi.fn(async()=>true),readCurrent:()=>session.document?{document:session.document}:null,
  clearError(){},retry(){},
})}));

function Workspace(){
  const navigation=useNativeNavigation();
  return navigation.projectId?<NativeWorkspace projectId={navigation.projectId} navigation={navigation}/>:<div>案件ホーム</div>;
}
beforeEach(()=>{
  history.replaceState(null,'','/?project=unavailable');localStorage.clear();sessionStorage.clear();
  session.document=null;session.error=null;session.loading=false;session.busy=false;session.save=vi.fn(async()=>false);
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false,tutorialEnabled:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();history.replaceState(null,'','/');});

it.each(['load-error','loading','not-migrated'])('can go home without attempting to save a %s workspace',async state=>{
  session.error=state==='load-error'?'文字起こし transcript.json が見つかりません':null;
  session.loading=state==='loading';
  const view=render(<Workspace/>);
  fireEvent.click(view.getByRole('button',{name:'ホームに戻る'}));
  await waitFor(()=>expect(view.getByText('案件ホーム')).toBeTruthy());
  expect(location.search).toBe('');expect(session.save).not.toHaveBeenCalled();
});

it('allows browser Back from an unavailable workspace without saving',async()=>{
  session.error='文字起こし transcript.json が見つかりません';const view=render(<Workspace/>);
  await act(async()=>{history.replaceState(null,'','/');window.dispatchEvent(new PopStateEvent('popstate'));});
  expect(view.getByText('案件ホーム')).toBeTruthy();expect(session.save).not.toHaveBeenCalled();
});

it('keeps a migration in progress in its workspace even before a document exists',async()=>{
  session.busy=true;const view=render(<Workspace/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'ホームに戻る'}));});
  expect(view.queryByText('案件ホーム')).toBeNull();expect(location.search).toBe('?project=unavailable');
  expect(session.save).not.toHaveBeenCalled();
});

it('retains a loaded document on save failure, then goes home after a successful retry',async()=>{
  session.document={schemaVersion:2,id:'loaded',revision:1,name:'loaded',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
    background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  session.error='保存できませんでした';const view=render(<Workspace/>);
  await act(async()=>{fireEvent.click(view.getByRole('button',{name:'ホームに戻る'}));await new Promise(resolve=>setTimeout(resolve,5));});
  expect(session.save).toHaveBeenCalledOnce();expect(view.queryByText('案件ホーム')).toBeNull();expect(location.search).toBe('?project=unavailable');
  session.save.mockResolvedValue(true);
  fireEvent.click(view.getByRole('button',{name:'ホームに戻る'}));
  await waitFor(()=>expect(view.getByText('案件ホーム')).toBeTruthy());
  expect(session.save).toHaveBeenCalledTimes(2);
});
