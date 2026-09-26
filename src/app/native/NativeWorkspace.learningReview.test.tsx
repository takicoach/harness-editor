/** @vitest-environment jsdom */
import {forwardRef,useImperativeHandle} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import {readDialogState} from '../tutorial/nativeTutorialDom';
import type {NativeExportStatus} from '../../shared/nativeExport';
import type {LearningDiffResponse} from '../../shared/types';

// 書き出しの完了通知（onComplete）から差分レビューを開く配線。NativeExportControl 自身も1ジョブ1回だが、
// 部品が作り直されると記憶が消えるので、親でも jobId ごとに1回だけ開く（閉じた後に同じ jobId が来ても開かない）。
const exportControl=vi.hoisted(()=>({onComplete:undefined as undefined|((job:NativeExportStatus)=>void)}));
vi.mock('./NativePreview',()=>({NativePreview:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({pause(){},flushManipulation:async()=>true}));return null;})}));
vi.mock('./NativeTimeline',()=>({NativeTimeline:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true,restoreCut:async()=>true,fitZoom(){}}));return null;})}));
vi.mock('./NativeInspector',()=>({NativeInspector:forwardRef((_props,ref)=>{useImperativeHandle(ref,()=>({flush:async()=>true,blurDraft(){}}));return null;})}));
vi.mock('./NativeScriptPanel',()=>({NativeScriptPanel:forwardRef(()=>null)}));
vi.mock('./NativeExportControl',()=>({NativeExportControl:(props:{onComplete?(job:NativeExportStatus):void})=>{exportControl.onComplete=props.onComplete;return null;}}));
vi.mock('./NativeTranscribeControl',()=>({NativeTranscribeControl:()=>null}));
vi.mock('../useAutoSave',()=>({useAutoSave:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle(){}})}));
vi.mock('../useEditorAgentConnection',()=>({useEditorAgentConnection:()=>({connection:'disconnected'})}));
vi.mock('./useNativeEditorBridge',()=>({useNativeEditorBridge:()=>({bridge:{},busy:false,resumeAutoSave(){}})}));
vi.mock('./useNativeSession',()=>({useNativeSession:()=>({state:{sessionId:'test',dirty:false,document:{
  schemaVersion:2,id:'learn',revision:1,name:'learn',fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
}},busy:false,execute:async()=>true,readCurrent:()=>({document:null}),save:async()=>true})}));

const DIFF:LearningDiffResponse={cut:null,words:null,ses:null,undistilledCount:0,aiEditCount:0,baselineLabel:'新エディターへ取り込んだ時点の内容',
  telops:[{kind:'changed',startFrame:0,endFrame:60,startSec:0,endSec:2,before:'ゆる素振り',after:'ゆるい素振り'}]};
const job=(id:string)=>({id,projectId:'case-a',revision:1,contentHash:'c'.repeat(64),executionId:null,phase:'complete',
  completedFrames:300,totalFrames:300,createdAt:'2026-09-25T00:00:00.000Z'}) satisfies NativeExportStatus;
const diffRequests:string[]=[];
beforeEach(()=>{
  diffRequests.length=0;exportControl.onComplete=undefined;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(String(url).startsWith('/api/learning/diff')){diffRequests.push(new URL(String(url),'http://x').searchParams.get('job')??'');return {ok:true,status:200,json:async()=>DIFF};}
    return {ok:true,status:200,json:async()=>({status:'unchanged',autoSaveDefaultEnabled:false})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('opens the diff review once per export job, even when the same job completes again after it was closed',async()=>{
  const view=render(<NativeWorkspace projectId="case-a"/>);
  await waitFor(()=>expect(exportControl.onComplete).toBeTypeOf('function'));
  await act(async()=>exportControl.onComplete!(job('job-1')));
  await waitFor(()=>expect(view.getByRole('dialog',{name:'AIとの差分レビュー'})).toBeTruthy());
  expect(diffRequests).toEqual(['job-1']);
  // チュートリアルはパネルを「開いているダイアログ」として読み、案内を隠す（MODAL_SELECTOR の .diff-review-overlay）。
  expect(document.querySelector('.diff-review-overlay')).not.toBeNull();
  expect(readDialogState().dialogOpen).toBe(true);
  fireEvent.click(view.getByRole('button',{name:'今回は学習しない'}));
  expect(view.queryByRole('dialog',{name:'AIとの差分レビュー'})).toBeNull();

  await act(async()=>exportControl.onComplete!(job('job-1')));
  expect(diffRequests).toEqual(['job-1']);
  expect(view.queryByRole('dialog',{name:'AIとの差分レビュー'})).toBeNull();

  // 別のジョブは開く（上の「開かない」が壊れた配線による空振りでないことの確認）。
  await act(async()=>exportControl.onComplete!(job('job-2')));
  await waitFor(()=>expect(view.getByRole('dialog',{name:'AIとの差分レビュー'})).toBeTruthy());
  expect(diffRequests).toEqual(['job-1','job-2']);
});
