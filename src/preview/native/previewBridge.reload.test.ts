/** @vitest-environment jsdom */
import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {NativePreviewBridge} from './previewBridge';

// `reload()` mounts a brand-new <iframe> element whose contentWindow is a fresh
// jsdom Window with no `harnessNative*` globals (nothing in the render page
// actually runs in this environment). Mocking `contentWindow` on the frame
// *after* awaiting `reload()`/the constructor is too late — the ready-poll
// inside the bridge would never observe it and would hang until its own
// 30s timeout. So we intercept `document.createElement('iframe')` and stamp
// the mock content window on each frame the instant it is created, before the
// bridge ever starts polling it.
function stubIframes(makers:Array<()=>Record<string,unknown>>){
  const original=document.createElement.bind(document);
  let call=0;
  return vi.spyOn(document,'createElement').mockImplementation((tag:string,...rest:unknown[])=>{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el=(original as any)(tag,...(rest as []));
    if(tag==='iframe'){
      const make=makers[Math.min(call,makers.length-1)]??readyWindow;call++;
      Object.defineProperty(el,'contentWindow',{configurable:true,value:make()});
    }
    return el;
  });
}

const readyWindow=()=>({harnessNativeReady:true,harnessNativeDispose:vi.fn(),harnessNativeClear:vi.fn()});

describe('NativePreviewBridge.reload',()=>{
  let container:HTMLElement;
  beforeEach(()=>{container=document.createElement('div');document.body.append(container);});
  afterEach(()=>{container.remove();vi.restoreAllMocks();});

  it('iframe を作り直し、src の id と preview=1 を保つ',async()=>{
    stubIframes([readyWindow,readyWindow]);
    const bridge=new NativePreviewBridge(container,'p1');
    const before=container.querySelector('iframe') as HTMLIFrameElement;
    await bridge.reload();
    const after=container.querySelector('iframe') as HTMLIFrameElement;
    expect(after).not.toBe(before);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(new URL(after.src,'http://localhost').searchParams.get('id')).toBe('p1');
    expect(new URL(after.src,'http://localhost').searchParams.get('preview')).toBe('1');
  });

  it('dispose 済みなら作り直さず、明示エラーで拒否する',async()=>{
    stubIframes([readyWindow]);
    const bridge=new NativePreviewBridge(container,'p1');
    bridge.dispose();
    await expect(bridge.reload()).rejects.toThrow('プレビューは閉じられています');
  });

  it('起動に失敗した iframe は捨て、失敗を投げる',async()=>{
    stubIframes([readyWindow,()=>({harnessNativeError:'描画に失敗しました',harnessNativeDispose:vi.fn()})]);
    const bridge=new NativePreviewBridge(container,'p1');
    await expect(bridge.reload()).rejects.toThrow('描画に失敗しました');
  });
});
