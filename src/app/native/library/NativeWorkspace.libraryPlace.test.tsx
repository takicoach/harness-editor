/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from '../NativeWorkspace';
const h=vi.hoisted(()=>({flushOk:true,busy:false,place:vi.fn(),prepareGate:null as Promise<void>|null}));
vi.mock('../NativePreview',()=>({NativePreview:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('../NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>h.flushOk}));return null;})}));
vi.mock('../NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('../NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('../NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('../NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:vi.fn(),cancel(){},picker:null})}));
vi.mock('../../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('../useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('../useNativeSession',()=>{
 const state={sessionId:'test',dirty:false,document:{schemaVersion:2,id:'p1',revision:0,name:'p1',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}}};
 return {useNativeSession:()=>({state,busy:h.busy,reference:vi.fn(),upload:vi.fn(),readCurrent:()=>state,accept:vi.fn(),placeFromLibrary:h.place})};
});
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear();h.flushOk=true;h.busy=false;h.place.mockReset();
 h.place.mockImplementation(()=>new Promise(r=>setTimeout(()=>r({ok:true,selectId:'c1'}),400)));
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url==='/api/library')return {ok:true,json:async()=>({ok:true,directory:'/lib',catalog:{version:2,packs:[],templates:[],media:[{key:'se:aa',kind:'se',name:'ポン',desc:'',file:'x',fingerprint:'aa'}]},missing:[]})};
  return {ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
 }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function open(){
 const view=render(<NativeWorkspace projectId="p1"/>);
 fireEvent.click(view.getByRole('tab',{name:'素材'}));fireEvent.click(await view.findByRole('radio',{name:/素材置場/}));
 return {view,card:(await view.findByRole('button',{name:'ポンを再生位置に置く'})) as HTMLButtonElement};
}
it('cannot place while the editor is locked',async()=>{
 h.busy=true;const {card}=await open();expect(card.disabled).toBe(true);fireEvent.click(card);expect(h.place).not.toHaveBeenCalled();
});
it('does not place when flushing input fails',async()=>{
 h.flushOk=false;const {card}=await open();fireEvent.click(card);
 await new Promise(r=>setTimeout(r,20));expect(h.place).not.toHaveBeenCalled();
});
it('places once on a double click and shows the busy card',async()=>{
 const {view,card}=await open();fireEvent.click(card);fireEvent.click(card);
 await waitFor(()=>expect(h.place).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(view.container.querySelector('[data-library-key="se:aa"]')!.getAttribute('data-busy')).toBe('true'));
 await waitFor(()=>expect(view.container.querySelector('[data-library-key="se:aa"]')!.getAttribute('data-busy')).toBeNull());
 expect(h.place).toHaveBeenCalledTimes(1);expect(typeof h.place.mock.calls[0]![2]).toBe('function');expect((h.place.mock.calls[0]![2] as ()=>string|null)()).toBeNull();
});
