/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createRef} from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {NativeTimeline,type NativeTimelineHandle} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {MAX_PX_PER_FRAME} from '../timeline/timelineGeometry';

// T6: NativeTimeline now mounts two ResizeObservers on the same scroller element
// (view measurement + the viewport hook's fit-zoom evaluation, the latter moved to
// useLayoutEffect so minZoom is correct before first paint). A real resize fires every
// observer watching the element, so the mock must do the same rather than keep only the
// last-constructed callback.
let resizers:Array<()=>void>=[];
const resize=()=>resizers.forEach(fn=>fn());
beforeEach(()=>{
  resizers=[];
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>undefined);
  vi.stubGlobal('ResizeObserver',class{constructor(fn:()=>void){resizers.push(fn);}observe(){}disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function doc():SequenceDocument{return {schemaVersion:2,id:'doc',name:'fit',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:868,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],clips:[]};}

it('fits the whole sequence once on open and raises the zoom when it later falls below the recomputed floor',()=>{
  // NOTE(T5): the original fixture shrank the viewport for the second assertion, but
  // floor = (clientWidth-132)/totalFrames only ever DECREASES as width shrinks (totalFrames fixed),
  // so `current.zoom < floor` can never fire on shrink alone — the scenario was unattainable as written.
  // Fixed by growing the viewport instead, which correctly exercises the raise-when-below-floor branch.
  const onZoomChange=vi.fn(),ref=createRef<NativeTimelineHandle>();
  const props={projectId:'p',document:doc(),waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:4,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange};
  const ui=render(<NativeTimeline ref={ref} {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:1000});
  act(()=>resize());
  expect(onZoomChange).toHaveBeenLastCalledWith(1);          // (1000-132)/868
  onZoomChange.mockClear();
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:4472});
  act(()=>resize());
  expect(onZoomChange).toHaveBeenLastCalledWith(5);          // (4472-132)/868 = 5, above the fixed zoom=4 prop
});
it('caps minZoom below MAX so short sequences keep a usable zoom range (T5 fix-round-1 regression)',()=>{
  // A short project (120 frames, e.g. a 4s clip at 30fps) in a wide viewport: fit hits MAX_PX_PER_FRAME,
  // which used to become both the slider's min and max, leaving zoom unusable (min===max).
  const onZoomChange=vi.fn(),onMinZoom=vi.fn(),ref=createRef<NativeTimelineHandle>();
  const shortDoc={...doc(),sequenceEndFrame:120};
  const props={projectId:'p',document:shortDoc,waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:12,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange,onMinZoom};
  // C1 fix-round-2: clientWidth must be fixed BEFORE render(), not after — the viewport hook's
  // fit-zoom effect runs in useLayoutEffect during mount, so setting it post-render leaves the
  // mount pass seeing jsdom's default clientWidth=0 and onMinZoom's first call fires with the
  // untouched MIN_PX_PER_FRAME default, never exercising nativeMinZoom's MAX-capping branch.
  Object.defineProperty(HTMLElement.prototype,'clientWidth',{configurable:true,value:1600});
  try{
    render(<NativeTimeline ref={ref} {...props}/>);
    act(()=>resize());
    const lastMinZoom=onMinZoom.mock.calls.at(-1)![0] as number;
    // (1600-132)/120 clamps to MAX_PX_PER_FRAME=12, then capped at MAX/2=6 (nativeMinZoom).
    expect(lastMinZoom).toBe(MAX_PX_PER_FRAME/2);
    expect(lastMinZoom).toBeLessThan(MAX_PX_PER_FRAME);
  }finally{
    Reflect.deleteProperty(HTMLElement.prototype,'clientWidth');
  }
});
it('recomputes minZoom on a width-only resize, not just when totalFrames changes (I1 fix-round-2 regression)',()=>{
  // The effect updating minZoom used to depend only on [scroller,totalFrames], so a real
  // ResizeObserver-fired resize (window width changing, totalFrames unchanged) moved the fit
  // zoom but left the slider's `min` stale. minZoom must now be recomputed inside the same
  // ResizeObserver evaluate() that moves the zoom.
  const onZoomChange=vi.fn(),onMinZoom=vi.fn(),ref=createRef<NativeTimelineHandle>();
  const props={projectId:'p',document:doc(),waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:4,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange,onMinZoom};
  const ui=render(<NativeTimeline ref={ref} {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:1600});
  act(()=>resize());                                          // (1600-132)/868 clamped; min=(1600-132)/868/... via nativeMinZoom
  onMinZoom.mockClear();
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:800});
  act(()=>resize());                                          // totalFrames unchanged (868) — width-only resize
  expect(onMinZoom).toHaveBeenCalled();
  const lastMinZoom=onMinZoom.mock.calls.at(-1)![0] as number;
  expect(lastMinZoom).toBeCloseTo((800-132)/868,5);            // nativeMinZoom floor for the new width
});
it('does not silently override a manual zoom when an edit shrinks totalFrames without an actual resize (T9 fix-round-1 regression)',()=>{
  // Reproduces ghost-loop-extension's undo in the waveform e2e: totalFrames shrinks back down
  // purely because of a document edit (not a real ResizeObserver-fired viewport resize), and the
  // previously-picked zoom must survive — only the slider's displayed floor may change.
  const onZoomChange=vi.fn(),ref=createRef<NativeTimelineHandle>();
  const wideDoc=doc();
  const props={projectId:'p',document:wideDoc,waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:8,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange};
  const ui=render(<NativeTimeline ref={ref} {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:4772});
  act(()=>resize()); // firstFit consumes here; zoom prop stays 8 for the rest of the test regardless.
  onZoomChange.mockClear();
  const shortDoc={...wideDoc,sequenceEndFrame:200};
  ui.rerender(<NativeTimeline ref={ref} {...props} document={shortDoc}/>);
  expect(onZoomChange).not.toHaveBeenCalled();
});
it('re-fits on demand through the imperative handle without touching the document',()=>{
  const onZoomChange=vi.fn(),ref=createRef<NativeTimelineHandle>(),document=doc();
  const ui=render(<NativeTimeline ref={ref} projectId="p" document={document} waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false}
    onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async()=>true)} onZoomChange={onZoomChange}/>);
  const scroller=ui.getByLabelText('タイムライン');
  Object.defineProperty(scroller,'clientWidth',{configurable:true,value:1736});
  act(()=>resize());onZoomChange.mockClear();
  act(()=>ref.current!.fitZoom());
  expect(onZoomChange).toHaveBeenCalledWith((1736-132)/868);
});
