/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { NativePreviewBridge } from './previewBridge';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it.each(['startup', 'render'] as const)('restores parent Error identity and metadata for iframe %s failures', async stage => {
  vi.useFakeTimers();
  const mount = document.createElement('div'); document.body.append(mount);
  const bridge = new NativePreviewBridge(mount, 'legacy', 'lease');
  const frame = mount.querySelector('iframe')!, view = frame.contentWindow!;
  const failure = {kind:'context-unavailable' as const, message:'字幕部品の接続が失われました', status:404, resource:'component' as const};
  if (stage === 'startup') { view.harnessNativeError = failure.message; view.harnessNativeFailure = failure; }
  else { view.harnessNativeReady = true; view.harnessNativePreviewFrame = async () => { throw failure; }; }
  const plan = new ScenePlan({schemaVersion:2,id:'bridge-test',name:'bridge-test',revision:0,fps:{num:30,den:1},
    resolution:{width:320,height:180},sequenceEndFrame:1,background:'#000000',transitions:[],transcripts:[],
    ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[]});
  const result = bridge.render(plan, 0, false, () => true).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(20);
    const error = await result;
    expect(error).toBeInstanceOf(Error); expect(error).toMatchObject(failure);
  } finally { bridge.dispose(); }
});
