// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createBrowserCaptureDeps } from './browserDeps';
import type { CaptureSpec } from './protocol';

it('applies the shared fallback before the capture font barrier and releases it on the next authored style', async () => {
  const container=document.createElement('div'); document.body.append(container);
  const beforeFonts=Object.getOwnPropertyDescriptor(document,'fonts');
  let release!:()=>void, started=0, family='"Noto Sans JP", sans-serif';
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const faces=new Set(); Object.defineProperty(faces,'ready',{get:()=>{
    expect(container.querySelector('span')?.style.fontFamily).toContain(started===1&&family.includes('Noto')?'HarnessLegacyCaption':'Arial');
    return ready;
  }});
  Object.defineProperty(document,'fonts',{configurable:true,value:faces});
  vi.stubGlobal('FontFace',class {status='unloaded';load(){started++;this.status='loading';return ready.then(()=>{this.status='loaded';return this;});}});
  const spec:CaptureSpec={layer:'telop',projectId:'font-test',videoConfig:{width:320,height:180,fps:30,durationInFrames:60},data:{telops:[{id:1,text:'同じ ABC 123',startFrame:0,endFrame:60}]}};
  const original=JSON.stringify(spec);
  const deps=createBrowserCaptureDeps({container,loadTelop:async()=>()=> <span style={{fontFamily:family,fontWeight:800}}>同じ ABC 123</span>});
  try {
    await deps.prepare?.(spec); deps.render({spec,frame:0,tick:1});
    let completed=false; const waiting=deps.waitForFonts().then(()=>{completed=true;});
    await Promise.resolve(); expect(started).toBe(1); expect(completed).toBe(false);
    release(); await waiting; expect(completed).toBe(true);
    deps.render({spec,frame:1,tick:2});
    expect(container.querySelector('span')?.style.fontFamily).toContain('HarnessLegacyCaption');
    family='Arial'; deps.render({spec,frame:2,tick:3}); await deps.waitForFonts();
    expect(container.querySelector('span')?.style.fontFamily).toBe('Arial'); expect(JSON.stringify(spec)).toBe(original);
  } finally {release();vi.unstubAllGlobals();if(beforeFonts)Object.defineProperty(document,'fonts',beforeFonts);else Reflect.deleteProperty(document,'fonts');container.remove();}
});

it('the real init/setFrame path waits for a caption font first encountered after init', async () => {
  vi.resetModules();
  const { createBrowserCaptureDeps } = await import('./browserDeps');
  const { createCaptureController } = await import('./protocol');
  const container = document.createElement('div'); document.body.append(container);
  const beforeFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  let release!: () => void, started = 0, completed = false;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const faces = new Set();
  Object.defineProperty(faces, 'ready', { get: () => started ? ready : Promise.resolve() });
  Object.defineProperty(document, 'fonts', { configurable: true, value: faces });
  vi.stubGlobal('FontFace', class {
    status = 'unloaded';
    load() { started++; this.status = 'loading'; return ready.then(() => { this.status = 'loaded'; return this; }); }
  });
  const spec: CaptureSpec = { layer: 'telop', projectId: 'late-font', videoConfig: { width: 320, height: 180, fps: 30, durationInFrames: 60 }, data: { telops: [{ id: 1, text: '途中から', startFrame: 20, endFrame: 60 }] } };
  const deps = createBrowserCaptureDeps({ container, loadTelop: async () => () => <span style={{ fontFamily: '"Noto Sans JP", sans-serif', fontWeight: 800 }}>途中から</span> });
  const controller = createCaptureController({ ...deps, requestAnimationFrame: callback => callback() });
  try {
    expect(await controller.init(spec)).toEqual({ ok: true });
    expect(started).toBe(0);
    const waiting = controller.setFrame(20).then(result => { completed = true; return result; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(started).toBe(1);
    expect(completed).toBe(false);
    expect(container.querySelector('span')?.style.fontFamily).toContain('HarnessLegacyCaption');
    release(); expect(await waiting).toEqual({ ok: true });
    expect(await controller.setFrame(21)).toEqual({ ok: true });
    expect(started).toBe(1);
    expect(container.querySelector('span')?.style.fontFamily).toContain('HarnessLegacyCaption');
  } finally {
    release(); vi.unstubAllGlobals();
    if (beforeFonts) Object.defineProperty(document, 'fonts', beforeFonts); else Reflect.deleteProperty(document, 'fonts');
    container.remove();
  }
});
