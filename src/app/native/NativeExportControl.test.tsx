/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeExportControl} from './NativeExportControl';
import * as nativeExport from '../../shared/nativeExport';
import * as notificationHistory from './notificationHistory';

const request=vi.hoisted(()=>vi.fn());
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),nativeRequest:request}));
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();localStorage.clear();vi.clearAllMocks();});
const status={id:'job',projectId:'p',revision:5,contentHash:'a'.repeat(64),executionId:'exec',phase:'complete',completedFrames:30,totalFrames:30,createdAt:'2026-09-11T00:00:00.000Z',settings:{resolution:'720p',quality:'light'},outputResolution:{width:1280,height:720}};
function setup(){
  request.mockImplementation(async(_project,path)=>{
    if(path==='/export/list')return {jobs:[],total:0,nextOffset:null};
    if(path==='/session')return {sessionId:'session',document:{revision:5}};
    if(path==='/export/preflight')return {checked:1,referenceCount:1,issues:[]};
    if(path==='/export/request')return {job:null};
    if(path==='/export')return status;
    throw new Error(path);
  });
  const save=vi.fn(async()=>true),props={projectId:'p',revision:5,resolution:{width:1920,height:1080},disabled:false,save};
  return {props,save};
}
it('opens settings without saving, then freezes chosen settings only when the user starts',async()=>{
  const {props,save}=setup(),view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));expect(save).not.toHaveBeenCalled();
  expect(view.getByRole('option',{name:'720p・軽量（1280×720）'})).toBeTruthy();
  fireEvent.change(view.getByLabelText('書き出し解像度'),{target:{value:'720p'}});
  fireEvent.change(view.getByLabelText('書き出し画質'),{target:{value:'light'}});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(save).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(call=>call[1]==='/export')).toEqual([['p','/export',{sessionId:'session',expectedRevision:5,executionId:expect.any(String),settings:{resolution:'720p',quality:'light'}}]]);
  expect(view.getByText('1280×720 · 軽量')).toBeTruthy();
});
it('shows named offline sources before creating any export request',async()=>{
 const {props}=setup(),normal=request.getMockImplementation()!;
 request.mockImplementation(async(...args)=>args[1]==='/export/preflight'?{checked:2,referenceCount:2,issues:[{assetId:'source-a',name:'撮影.mov',message:'参照先が見つかりません。接続を確認してください。'},{assetId:'source-b',name:'音声.wav',message:'素材が変更されています。'}]}:normal(...args));
 const view=render(<NativeExportControl {...props}/>);await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
 await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
 expect(view.getByRole('alert').textContent).toContain('撮影.mov');expect(view.getByRole('alert').textContent).toContain('音声.wav');
 expect(request.mock.calls.some(args=>args[1]==='/export')).toBe(false);expect(sessionStorage.getItem('harness.native.export.pending:p')).toBeNull();
 request.mockImplementation(normal);await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
 expect(request.mock.calls.filter(args=>args[1]==='/export')).toHaveLength(1);
});
it('waits for source checks and does not start the old project after switching',async()=>{
 const {props}=setup(),normal=request.getMockImplementation()!;let finish!:(value:unknown)=>void;
 request.mockImplementation(async(...args)=>args[1]==='/export/preflight'?new Promise(resolve=>{finish=resolve;}):normal(...args));
 const view=render(<NativeExportControl {...props}/>);await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
 await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
 expect(view.getByRole('progressbar',{name:'素材と接続を確認しています'})).toBeDefined();expect(request.mock.calls.some(args=>args[1]==='/export')).toBe(false);
 view.rerender(<NativeExportControl {...props} projectId="other"/>);
 await act(async()=>finish({checked:1,referenceCount:1,issues:[]}));
 expect(request.mock.calls.some(args=>args[1]==='/export')).toBe(false);expect(sessionStorage.getItem('harness.native.export.pending:p')).toBeNull();
});
it('keeps the exact settings and saved revision across an uncertain response, reload and replay',async()=>{
  const {props,save}=setup(),normal=request.getMockImplementation()!;
  request.mockImplementation(async(...args)=>{if(args[1]==='/export')throw new Error('connection lost');return normal(...args);});
  const view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));fireEvent.change(view.getByLabelText('書き出し解像度'),{target:{value:'720p'}});
  fireEvent.change(view.getByLabelText('書き出し画質'),{target:{value:'light'}});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  const first=request.mock.calls.find(call=>call[1]==='/export')![2];
  expect(JSON.parse(sessionStorage.getItem('harness.native.export.pending:p')!)).toEqual(first);
  localStorage.setItem('sme:render-preset',JSON.stringify({resolution:'full',quality:'high'}));
  view.unmount();request.mockImplementation(normal);
  const restored=render(<NativeExportControl {...props} revision={9}/>);
  await waitFor(()=>expect((restored.getByRole('button',{name:'開始状況を再確認'}) as HTMLButtonElement).disabled).toBe(false));
  await act(async()=>fireEvent.click(restored.getByRole('button',{name:'開始状況を再確認'})));
  expect(request.mock.calls.filter(call=>call[1]==='/export').map(call=>call[2])).toEqual([first,first]);
  expect(save).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem('harness.native.export.pending:p')).toBeNull();
  expect(JSON.parse(localStorage.getItem('sme:render-preset')!)).toEqual({resolution:'full',quality:'high'});
});
it('inherits legacy resolution and quality without sending its output name or ducking to native export',async()=>{
  localStorage.setItem('sme:render-preset',JSON.stringify({resolution:'1080p',quality:'standard',outputName:'old-project.mp4',ducking:{enabled:true,strength:'mid'}}));
  const {props}=setup(),view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  expect((view.getByLabelText('書き出し解像度') as HTMLSelectElement).value).toBe('1080p');
  expect((view.getByLabelText('書き出し画質') as HTMLSelectElement).value).toBe('standard');
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(request.mock.calls.find(call=>call[1]==='/export')![2].settings).toEqual({resolution:'1080p',quality:'standard'});
  expect(JSON.parse(localStorage.getItem('sme:render-preset')!)).toEqual({resolution:'1080p',quality:'standard',ducking:{enabled:true,strength:'mid'}});
});
it.each(['corrupt','read-denied','write-denied'] as const)('continues export with %s preference storage',async failure=>{
  if(failure==='corrupt')localStorage.setItem('sme:render-preset','{broken');
  if(failure==='read-denied')vi.spyOn(window,'localStorage','get').mockImplementation(()=>{throw new Error('storage denied');});
  if(failure==='write-denied'){
    const set=Storage.prototype.setItem;
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key:string,value:string){if(this===window.localStorage)throw new Error('quota exceeded');set.call(this,key,value);});
  }
  const {props,save}=setup(),view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  expect((view.getByLabelText('書き出し解像度') as HTMLSelectElement).value).toBe('full');
  expect((view.getByLabelText('書き出し画質') as HTMLSelectElement).value).toBe('high');
  fireEvent.change(view.getByLabelText('書き出し解像度'),{target:{value:'720p'}});fireEvent.change(view.getByLabelText('書き出し画質'),{target:{value:'light'}});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(save).toHaveBeenCalledTimes(1);expect(request.mock.calls.find(call=>call[1]==='/export')![2].settings).toEqual({resolution:'720p',quality:'light'});
  expect(view.queryByRole('alert')).toBeNull();
});
it('remembers started settings across a new mount, but does not remember an unstarted selection',async()=>{
  const {props}=setup(),view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  fireEvent.change(view.getByLabelText('書き出し解像度'),{target:{value:'720p'}});fireEvent.change(view.getByLabelText('書き出し画質'),{target:{value:'light'}});
  expect(localStorage.getItem('sme:render-preset')).toBeNull();
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(JSON.parse(localStorage.getItem('sme:render-preset')!)).toEqual({resolution:'720p',quality:'light'});
  view.unmount();const next=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((next.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(next.getByText('書き出し'));
  expect((next.getByLabelText('書き出し解像度') as HTMLSelectElement).value).toBe('720p');expect((next.getByLabelText('書き出し画質') as HTMLSelectElement).value).toBe('light');
});
it('does not enqueue export after save rejection and preserves the chosen settings for retry',async()=>{
  const {props,save}=setup();save.mockResolvedValue(false);const view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));fireEvent.change(view.getByLabelText('書き出し画質'),{target:{value:'standard'}});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(request.mock.calls.some(call=>call[1]==='/export')).toBe(false);
  expect((view.getByLabelText('書き出し画質') as HTMLSelectElement).value).toBe('standard');
  expect(sessionStorage.getItem('harness.native.export.pending:p')).toBeNull();
});
it('reports setting validation failure, releases starting, and allows a corrected retry',async()=>{
  const {props,save}=setup(),view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  vi.spyOn(nativeExport,'nativeExportSettings').mockImplementationOnce(()=>{throw new Error('invalid export setting');});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(view.getByRole('alert').textContent).toBe('invalid export setting');
  expect((view.getByRole('group',{name:'書き出し設定'}) as HTMLFieldSetElement).disabled).toBe(false);
  expect(save).not.toHaveBeenCalled();expect(request.mock.calls.some(call=>call[1]==='/export')).toBe(false);
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(save).toHaveBeenCalledTimes(1);expect(view.queryByRole('alert')).toBeNull();
});
it('clears a previous failure when opening fresh settings',async()=>{
  const {props,save}=setup();save.mockRejectedValueOnce(new Error('save failed'));
  const view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(view.getByRole('alert').textContent).toBe('save failed');
  fireEvent.click(view.getByRole('button',{name:'書き出しパネルを閉じる'}));fireEvent.click(view.getByRole('button',{name:'書き出し'}));
  expect(view.queryByRole('alert')).toBeNull();expect(save).toHaveBeenCalledTimes(1);
});
it('retains the uncertain-request error during pending replay, then clears it on acceptance',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!;
  request.mockImplementation(async(...args)=>{if(args[1]==='/export')throw new Error('connection lost');return normal(...args);});
  const view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(view.getByRole('alert').textContent).toBe('connection lost');
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  request.mockImplementation(async(...args)=>{if(args[1]==='/export'){await gate;return status;}return normal(...args);});
  try{
    await act(async()=>fireEvent.click(view.getByRole('button',{name:'開始状況を再確認'})));
    expect(view.getByRole('alert').textContent).toBe('connection lost');
  }finally{await act(async()=>release());}
  expect(view.queryByRole('alert')).toBeNull();
});
it('distinguishes known history settings without inventing settings for old records',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!;
  const {settings:_settings,outputResolution:_resolution,...legacy}=status;
  request.mockImplementation(async(...args)=>args[1]==='/export/list'?{jobs:[
    {...status,id:'full',settings:{resolution:'full',quality:'high'},outputResolution:{width:640,height:360}},
    {...status,id:'small',outputResolution:{width:426,height:240}},
    {...legacy,id:'old'},
  ],total:3,nextOffset:null}:normal(...args));
  const view=render(<NativeExportControl {...props}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  fireEvent.click(view.getByText('書き出し履歴（3件）'));
  const buttons=within(view.getByRole('list',{name:'書き出し履歴'})).getAllByRole('button');
  expect(buttons[0]!.textContent).toContain('そのまま · 640×360 · 高画質');
  expect(buttons[1]!.textContent).toContain('720p · 426×240 · 軽量');
  expect(buttons[2]!.textContent).not.toMatch(/そのまま|1080p|720p|×|高画質|標準|軽量/);
});
it('does not report a job that was already complete when the screen opened, nor one picked from history',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!,onComplete=vi.fn();
  request.mockImplementation(async(...args)=>args[1]==='/export/list'?{jobs:[status,{...status,id:'older'}],total:2,nextOffset:null}:normal(...args));
  const view=render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByRole('button',{name:'書き出し結果を表示'}));fireEvent.click(view.getByText('書き出し履歴（2件）'));
  fireEvent.click(within(view.getByRole('list',{name:'書き出し履歴'})).getAllByRole('button')[1]!);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,700));});
  expect(onComplete).not.toHaveBeenCalled();
});
it('reports the running → complete transition of a started job exactly once',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!,onComplete=vi.fn();
  const running={...status,phase:'rendering',completedFrames:10};let polls=0,started=false;
  request.mockImplementation(async(...args)=>{
    if(args[1]==='/export'){started=true;return running;}
    if(args[1]==='/export/list')return {jobs:started?[running]:[],total:started?1:0,nextOffset:null};
    if(args[1]==='/export/status'){polls++;return polls<2?running:status;}
    return normal(...args);
  });
  const view=render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(onComplete).not.toHaveBeenCalled();
  await waitFor(()=>expect(onComplete).toHaveBeenCalledTimes(1),{timeout:3000});
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({id:'job',phase:'complete'}));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,700));});
  expect(onComplete).toHaveBeenCalledTimes(1);
});
it('reports a job recovered complete after a lost start response once, including the replay after reload',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!,onComplete=vi.fn();
  request.mockImplementation(async(...args)=>{
    if(args[1]==='/export')throw new Error('connection lost');
    if(args[1]==='/export/request')return {job:status};
    return normal(...args);
  });
  const view=render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(onComplete).toHaveBeenCalledTimes(1);
  view.unmount();
  sessionStorage.setItem('harness.native.export.pending:p',JSON.stringify({sessionId:'session',expectedRevision:5,executionId:'exec'}));
  const reloaded=vi.fn();render(<NativeExportControl {...props} onComplete={reloaded}/>);
  await waitFor(()=>expect(reloaded).toHaveBeenCalledTimes(1));
});
it('reports a running job it found on opening when that job completes',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!,onComplete=vi.fn();
  const running={...status,phase:'rendering',completedFrames:10};
  request.mockImplementation(async(...args)=>{
    if(args[1]==='/export/list')return {jobs:[running],total:1,nextOffset:null};
    if(args[1]==='/export/status')return status;
    return normal(...args);
  });
  render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect(onComplete).toHaveBeenCalledTimes(1),{timeout:3000});
});
it('suppresses a repeated complete delivery for the same job even after onComplete is swapped by a rerender',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!;
  const first=vi.fn(),second=vi.fn();
  const running={...status,phase:'rendering',completedFrames:10};
  let listCalls=0;let statusCalls=0;let releaseList!:()=>void;
  const listGate=new Promise<void>(resolve=>{releaseList=resolve;});
  request.mockImplementation(async(...args)=>{
    if(args[1]==='/export')return running;
    if(args[1]==='/export/list'){
      listCalls++;
      if(listCalls===1)return {jobs:[],total:0,nextOffset:null};
      await listGate;
      // A stale snapshot: by the time this resolves the job already completed once,
      // but the list still shows the job running.
      return {jobs:[running],total:1,nextOffset:null};
    }
    if(args[1]==='/export/status'){statusCalls++;return status;}
    return normal(...args);
  });
  const view=render(<NativeExportControl {...props} onComplete={first}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  await waitFor(()=>expect(first).toHaveBeenCalledTimes(1),{timeout:3000});
  view.rerender(<NativeExportControl {...props} onComplete={second}/>);
  const statusBefore=statusCalls;
  releaseList();
  // Letting the stale list resolve reinstates a running entry, restarting the poller,
  // which then receives the same job complete a second time. Prove that re-poll really
  // happened (existence check) before asserting it was not reported again; otherwise a
  // poller that never restarted would pass this test vacuously.
  // The status response is handled (notifyComplete) in the microtasks right after the mocked
  // request resolves, so by the time waitFor observes the call, the repeated delivery has been decided.
  await waitFor(()=>expect(statusCalls).toBeGreaterThan(statusBefore),{timeout:3000});
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});
it('reports completion found in the list refreshed right after accepting a job that finished in between',async()=>{
  const {props}=setup(),normal=request.getMockImplementation()!,onComplete=vi.fn();
  const running={...status,phase:'rendering',completedFrames:10};let listCalls=0;
  request.mockImplementation(async(...args)=>{
    if(args[1]==='/export')return running;
    if(args[1]==='/export/list'){
      listCalls++;
      return listCalls===1?{jobs:[],total:0,nextOffset:null}:{jobs:[status],total:1,nextOffset:null};
    }
    // The poller itself must not be what reports completion in this scenario.
    if(args[1]==='/export/status')return running;
    return normal(...args);
  });
  const view=render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  await waitFor(()=>expect(onComplete).toHaveBeenCalledTimes(1),{timeout:3000});
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({id:'job',phase:'complete'}));
});
it('routes a throwing onComplete to the notification history, not the export panel error',async()=>{
  const {props}=setup(),onComplete=vi.fn(()=>{throw new Error('listener boom');});
  const spy=vi.spyOn(notificationHistory,'reportEditorError').mockImplementation(()=>{});
  const view=render(<NativeExportControl {...props} onComplete={onComplete}/>);
  await waitFor(()=>expect((view.getByText('書き出し') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByText('書き出し'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'書き出し開始'})));
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('p',expect.any(String),'listener boom');
  expect(view.queryByRole('alert')).toBeNull();
});
