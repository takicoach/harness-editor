/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useMeasuredBox } from './useMeasuredBox';
import type { LegacyMeasurementDisplaySnapshot } from '../../preview/native/legacyMeasurement';
import { nativeMeasurementRect } from './nativeMeasurements';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});
it('uses the actual iframe viewport and clears a retired measurement instead of retaining its selection box',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const overlay=document.createElement('div');document.body.append(overlay);
  vi.spyOn(overlay,'getBoundingClientRect').mockReturnValue({left:10,top:20,width:500,height:300} as DOMRect);
  let snapshot:LegacyMeasurementDisplaySnapshot|null={documentId:'a',revision:1,frame:20,resolution:{width:640,height:360},
    viewport:{left:30,top:60,width:320,height:180},items:[{kind:'telop',id:7,rect:{x:100,y:200,w:300,h:40}}]};
  const reader=vi.fn(()=>snapshot),rootRef={current:overlay},playerRef={current:null};
  const hook=renderHook(()=>useMeasuredBox({rootRef,playerRef,kind:'telop',id:7,readNativeMeasurement:reader}));
  expect(hook.result.current).toEqual({source:'measured',rect:{x:70,y:140,w:150,h:20}});
  snapshot={...snapshot,viewport:{left:90,top:60,width:160,height:90}};hook.rerender();
  expect(hook.result.current.rect).toEqual({x:105,y:90,w:75,h:10});
  expect(nativeMeasurementRect({...snapshot,viewport:{...snapshot.viewport,width:0}},snapshot.items[0]!,{left:10,top:20})).toBeNull();
  snapshot=null;hook.rerender();expect(hook.result.current).toEqual({source:'fallback',rect:null});
});
