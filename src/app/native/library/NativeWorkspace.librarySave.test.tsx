/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from '../NativeWorkspace';
const dur={num:1,den:1};
const audio={index:0,kind:'audio' as const,duration:dur,codec:'aac'};
const mk=(id:string,over:object)=>({id,kind:'media',file:`public/${id}`,name:id,fingerprint:id,streams:[audio],...over});
const state=vi.hoisted(()=>({assets:[] as unknown[]}));
vi.mock('../NativePreview',()=>({NativePreview:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('../NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('../NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('../NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('../NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('../NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:vi.fn(),cancel(){},picker:null})}));
vi.mock('../../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('../useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
vi.mock('../useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
 schemaVersion:2,id:'p1',revision:0,name:'p1',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
 background:'#000',assets:state.assets,tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}
}},busy:false,reference:vi.fn(),upload:vi.fn()})}));
const calls:{url:string;init?:RequestInit}[]=[];
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear();calls.length=0;
 state.assets.length=0;
 state.assets.push(
  mk('pic',{kind:'image',streams:[],name:'pic'}),
  mk('pop',{name:'pop',file:'public/se/pop.mp3',origin:{kind:'import',role:'effect'}}),
  mk('theme',{name:'theme',file:'public/BGM/theme.mp3',origin:{kind:'import',role:'music'}}),
  mk('movie',{name:'movie',streams:[{index:0,kind:'video',duration:dur,codec:'h264'},audio]}),
  mk('grade',{kind:'lut',name:'grade',streams:[]}),
 );
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  calls.push({url,init});
  if(url==='/api/library/save')return {ok:true,json:async()=>({item:{key:'k',kind:'se',name:'ポン',desc:'',file:'x',fingerprint:'f'},created:true})};
  if(url==='/api/library')return {ok:true,json:async()=>({ok:true,directory:'/lib',catalog:{version:2,packs:[],templates:[],media:[]},missing:[]})};
  return {ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
 }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows the library save button only on image/se/bgm rows and saves an se row',async()=>{
 const view=render(<NativeWorkspace projectId="p1"/>);
 fireEvent.click(view.getByRole('tab',{name:'素材'}));
 const label=(n:string)=>`${n}を素材置場に保存`;
 // 動画タブ（既定）: 映像付き media と lut には出ない
 await view.findByLabelText('movieを案件から外す');
 expect(view.queryByLabelText(label('movie'))).toBeNull();expect(view.queryByLabelText(label('grade'))).toBeNull();
 fireEvent.click(await view.findByRole('tab',{name:/画像/}));expect(await view.findByLabelText(label('pic'))).toBeTruthy();
 fireEvent.click(await view.findByRole('tab',{name:/BGM/}));expect(await view.findByLabelText(label('theme'))).toBeTruthy();
 fireEvent.click(await view.findByRole('tab',{name:/効果音/}));
 expect(calls.some(c=>c.url==='/api/library')).toBe(false);
 fireEvent.click(await view.findByLabelText(label('pop')));
 fireEvent.change(view.getByLabelText('名前'),{target:{value:'ポン'}});
 fireEvent.change(view.getByLabelText('説明（任意）'),{target:{value:'軽い音'}});
 fireEvent.click(within(view.getByLabelText('名前').closest('[role=dialog]') as HTMLElement).getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(view.getByText(/素材置場に保存しました/)).toBeTruthy());
 const save=calls.find(c=>c.url==='/api/library/save')!;
 expect(JSON.parse(String(save.init!.body))).toEqual({projectId:'p1',assetId:'pop',kind:'se',name:'ポン',desc:'軽い音'});
 // 一覧の再取得は置場を開いた時に行われる（保存直後は閉じているので読み直し済みの状態で開く）
 fireEvent.click(view.getByRole('radio',{name:/素材置場/}));
 await waitFor(()=>expect(calls.some(c=>c.url==='/api/library')).toBe(true));
});
