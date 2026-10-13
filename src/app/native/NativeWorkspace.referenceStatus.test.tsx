/** @vitest-environment jsdom */
// リンク素材の照合中（checking）はエラーではない: バナーに入れず、素材行に「確認中」だけ出す。
import {forwardRef,useImperativeHandle} from 'react';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';

vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_p,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef(()=>null)}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:()=>null}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false})}));
const audition=vi.hoisted(()=>({playingId:null,toggle(){},stop(){}}));   // 同じ関数を返す（stop の参照が毎回変わると効果が回り続けて描画が終わらない）
vi.mock('./useAssetAudition',()=>({useAssetAudition:()=>audition}));
const linked=(id:string,name:string,hex:string)=>({id,name,file:`.harness/references/${hex.repeat(64)}.wav`,kind:'media',fingerprint:hex.repeat(64),
  streams:[{kind:'audio',index:0,codec:'pcm_s16le',sampleRate:48000,channels:2,duration:{num:2,den:1}}]});
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'linked',revision:0,name:'linked',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
  assets:[linked('r1','SD1.wav','a'),linked('r2','SD2.wav','b')],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
}},busy:false,execute:vi.fn(async()=>true),readCurrent:()=>({document:null}),save:vi.fn(async()=>true)})}));
const states:Record<string,string>={};
beforeEach(()=>{
  sessionStorage.clear();
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(String(url).startsWith('/api/sequence/reference/status')){const asset=new URL(url,'http://localhost').searchParams.get('asset')!;return {ok:true,json:async()=>({state:states[asset]})};}
    return {ok:true,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const open=()=>{const view=render(<NativeWorkspace projectId="linked"/>);fireEvent.click(view.getByRole('tab',{name:'素材'}));fireEvent.click(view.getByRole('tab',{name:'BGM 2'}));return view;};

it('a link still being checked shows 確認中 on its row and no banner, then clears when the check completes',async()=>{
  states.r1='checking';states.r2='ok';
  const view=open();
  await waitFor(()=>expect(view.getAllByText('確認中')).toHaveLength(1));
  expect(view.container.querySelector('.native-reference-notice')).toBeNull();
  expect(view.getByText('確認中').closest('.native-asset-link')?.getAttribute('data-unavailable')).toBeNull();
  states.r1='ok';
  await waitFor(()=>expect(view.queryByText('確認中')).toBeNull(),{timeout:3000});   // 照合中は 2 秒ごとに確かめる
  expect(view.container.querySelector('.native-reference-notice')).toBeNull();
});
it('counts only real problems in the banner when another link is still being checked',async()=>{
  states.r1='checking';states.r2='missing';
  const view=open();
  await waitFor(()=>expect(view.container.querySelector('.native-reference-notice')).not.toBeNull());
  expect(view.getByRole('alert').textContent).toContain('素材が見つかりません（1件）');
  expect(view.getByRole('button',{name:'SD2.wavをリンクし直す'})).toBeTruthy();expect(view.queryByRole('button',{name:'SD1.wavをリンクし直す'})).toBeNull();
  expect(view.getByText('確認中')).toBeTruthy();
});
