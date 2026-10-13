/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import * as scenePlan from '../../core/sequence/scenePlan';
import {fixture} from '../../core/sequence/fixtures';
import {NativeTimeline} from './NativeTimeline';
vi.mock('./NativeFilmstrip',()=>({NativeFilmstrip:()=>null}));
vi.mock('./NativeWaveform',()=>({NativeWaveform:()=>null}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('the timeline asks for the shared plan of the document object it draws (no plan of its own)',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const shared=vi.spyOn(scenePlan,'scenePlanFor'),document=fixture();
  render(<NativeTimeline projectId="p" document={document} waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false}
    onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async()=>true)}/>);
  expect(shared).toHaveBeenCalledWith(document);
});
