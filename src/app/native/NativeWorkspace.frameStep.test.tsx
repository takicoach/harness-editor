/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

const transport=vi.hoisted(()=>({seek:vi.fn(),seekBy:vi.fn(),pause:vi.fn(),play:vi.fn(),toggle:vi.fn()}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{
  useImperativeHandle(ref,()=>transport);return <div aria-label="test monitor"/>;
})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef(()=>null)}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:()=>null}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'keyboard',revision:0,name:'keyboard',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false})}));
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})}))));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});

it('routes consecutive arrow/repeat/Shift inputs as deltas without consulting displayed state',()=>{
  render(<NativeWorkspace projectId="keyboard"/>);
  fireEvent.keyDown(document.body,{key:'ArrowLeft'});
  fireEvent.keyDown(document.body,{key:'ArrowLeft',repeat:true});
  fireEvent.keyDown(document.body,{key:'ArrowRight',shiftKey:true});
  expect(transport.seekBy.mock.calls).toEqual([[-1],[-1],[10]]);
  expect(transport.seek).not.toHaveBeenCalled();
});

it.each(['input','textarea','select','editable','dialog','ime','modal'])('does not step while %s owns keyboard input',kind=>{
  const view=render(<NativeWorkspace projectId="keyboard"/>);
  let target:HTMLElement=document.body;
  if(kind==='modal'){
    const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');view.container.append(modal);
  }else if(kind!=='ime'){
    target=document.createElement(['input','textarea','select'].includes(kind)?kind:'div');
    if(kind==='editable')target.setAttribute('contenteditable','true');
    if(kind==='dialog')target.setAttribute('role','dialog');
    view.container.append(target);
  }
  fireEvent.keyDown(target,{key:'ArrowLeft',isComposing:kind==='ime'});
  expect(transport.seekBy).not.toHaveBeenCalled();expect(transport.seek).not.toHaveBeenCalled();
});
