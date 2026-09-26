import { NativeSceneRenderer } from './sceneRenderer';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceDocument } from '../../core/sequence/model';
import { parseSequence } from '../../core/sequence/validate';
import type {RenderedSceneGeometry} from './renderGeometry';
import { previewFailure, type NativePreviewFailure } from './previewError';
import type { LegacyMeasurementRequest, LegacyMeasurementSnapshot } from './legacyMeasurement';

declare global {
  interface Window { harnessNativeFrame?: (frame: number) => Promise<void>; harnessNativeReady?: boolean; harnessNativeError?: string; harnessNativeFailure?: NativePreviewFailure;
    harnessNativePreviewFrame?: (document: string, frame: number, bypass: boolean, isCurrent: () => boolean) => Promise<RenderedSceneGeometry|null>;
    harnessNativeGeometry?:()=>RenderedSceneGeometry|null;
    harnessNativeMeasureLegacy?:(request:LegacyMeasurementRequest)=>LegacyMeasurementSnapshot|null;
    harnessNativeClear?: () => void; harnessNativeDispose?: () => void }
}
const query = new URLSearchParams(location.search), project = query.get('id'), job = query.get('job');
async function initialize() {
  if (query.get('host') === '1') return;
  if (project && query.get('preview') === '1') {
    const legacyContext = query.get('legacyContext');
    const renderer = new NativeSceneRenderer(document.getElementById('stage')!, project, legacyContext
      ? (asset, component) => `/api/legacy-preview/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: project, context: legacyContext, asset })}`
      : undefined);
    window.harnessNativeGeometry=()=>renderer.geometry();
    window.harnessNativeMeasureLegacy=request=>renderer.measureLegacy(request);
    let previous: string | undefined, plan: ScenePlan;
    window.harnessNativePreviewFrame = async (serialized, frame, bypass, isCurrent) => {
      try {
        if (serialized !== previous) { plan = new ScenePlan(parseSequence(serialized)); previous = serialized; }
        await renderer.render(plan, frame, bypass, isCurrent);
        return isCurrent()?renderer.geometry():null;
      } catch (error) { throw previewFailure(error); }
    };
    window.harnessNativeClear = () => renderer.clear(); window.harnessNativeDispose = () => renderer.dispose();
    window.harnessNativeReady = true; return;
  }
  if (!project || !job) throw new Error('書き出しジョブが指定されていません');
  const params = new URLSearchParams({ id: project, job });
  const response = await fetch(`/api/sequence/export/input?${params}`);
  const input = await response.json(); if (!response.ok) throw new Error(input.error ?? '固定した編集版を読み込めません');
  const plan = new ScenePlan(input.document as SequenceDocument), stage = document.getElementById('stage')!;
  const renderer = new NativeSceneRenderer(stage, project, (asset, component) => `/api/sequence/export/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: project, job, asset })}`);
  window.harnessNativeFrame = async frame => { await renderer.render(plan, frame); };
  window.harnessNativeReady = true;
}
void initialize().catch(error => { window.harnessNativeFailure = previewFailure(error); window.harnessNativeError = window.harnessNativeFailure.message; });
