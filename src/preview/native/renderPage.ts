import { NativeSceneRenderer } from './sceneRenderer';
import { nativeDecodeStats, type NativeDecodeStats } from './mp4FrameSource';
import { exportRendererOptions, parseRetainFrames, type NativeFrameSample } from './exportSourceRelease';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceDocument } from '../../core/sequence/model';
import { parseSequence } from '../../core/sequence/validate';
import type {RenderedSceneGeometry} from './renderGeometry';
import { previewFailure, type NativePreviewFailure } from './previewError';
import type { LegacyMeasurementRequest, LegacyMeasurementSnapshot } from './legacyMeasurement';

declare global {
  interface Window { harnessNativeFrame?: (frame: number) => Promise<void>; harnessNativeReady?: boolean; harnessNativeError?: string; harnessNativeFailure?: NativePreviewFailure;
    harnessNativePreviewFrame?: (document: string, frame: number, bypass: boolean, isCurrent: () => boolean) => Promise<RenderedSceneGeometry|null>;
    harnessNativePreviewPlan?: (plan: ScenePlan, frame: number, bypass: boolean, isCurrent: () => boolean) => Promise<RenderedSceneGeometry|null>;
    harnessNativeGeometry?:()=>RenderedSceneGeometry|null;
    harnessNativeMeasureLegacy?:(request:LegacyMeasurementRequest)=>LegacyMeasurementSnapshot|null;
    harnessNativeClear?: () => void; harnessNativeDispose?: () => void;
    /** Export-speed measurement: decoder counters of this page. */
    harnessNativeDecodeStats?: () => NativeDecodeStats;
    /** Export measurement: the source sample each video layer of the last frame used. */
    harnessNativeFrameSamples?: () => NativeFrameSample[];
    harnessNativeFrameTiming?: () => Record<string, number> | null }
}
const query = new URLSearchParams(location.search), project = query.get('id'), job = query.get('job'), thumbnailJob = query.get('thumbnailJob'), slidesJob = query.get('slidesJob');
async function initialize() {
  if (query.get('host') === '1') return;
  if (project && query.get('preview') === '1') {
    const legacyContext = query.get('legacyContext');
    const thumbnail = query.get('thumbnail') === '1', slides = query.get('slides') === '1';
    const renderer = new NativeSceneRenderer(document.getElementById('stage')!, project, legacyContext
      ? (asset, component) => `/api/legacy-preview/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: project, context: legacyContext, asset })}`
      // サムネのキャンバスは原本を読む（/api/sequence/asset ではないので preview=1 の軽い代わりの映像は付かない）。
      : thumbnail ? asset => `/api/thumbnail/asset?${new URLSearchParams({ id: project, asset })}`
      // スライドのキャンバスはスライド案件の素材（原本）を読む。
      : slides ? asset => `/api/slides/asset?${new URLSearchParams({ id: project, asset })}` : undefined);
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
    // 親の場面計画をそのまま描く（文字列化と検証つきの読み直しをしない）。外から文書を渡す口（harnessNativePreviewFrame）は今のまま検証する。
    window.harnessNativePreviewPlan = async (shared, frame, bypass, isCurrent) => {
      try { await renderer.render(shared, frame, bypass, isCurrent); return isCurrent()?renderer.geometry():null; }
      catch (error) { throw previewFailure(error); }
    };
    window.harnessNativeClear = () => renderer.clear(); window.harnessNativeDispose = () => renderer.dispose();
    window.harnessNativeReady = true; return;
  }
  if (project && slidesJob) {
    // スライドの書き出し: コマ番号＝ページ番号。各ページを描く直前に、そのページの 1 コマの文書（プレビューと同じ変換）を受け取る。
    const renderer = new NativeSceneRenderer(document.getElementById('stage')!, project,
      asset => `/api/slides/export/asset?${new URLSearchParams({ id: project, job: slidesJob, asset })}`);
    window.harnessNativeFrame = async index => {
      const response = await fetch(`/api/slides/export/input?${new URLSearchParams({ id: project, job: slidesJob, page: String(index) })}`);
      const input = await response.json(); if (!response.ok) throw new Error(input.error ?? 'スライドの入力を読み込めません');
      await renderer.render(new ScenePlan(input.document as SequenceDocument), 0);
    };
    window.harnessNativeReady = true; return;
  }
  if (project && thumbnailJob) {
    const params = new URLSearchParams({ id: project, job: thumbnailJob });
    const response = await fetch(`/api/thumbnail/export/input?${params}`);
    const input = await response.json(); if (!response.ok) throw new Error(input.error ?? 'サムネの入力を読み込めません');
    const plan = new ScenePlan(input.document as SequenceDocument);
    const renderer = new NativeSceneRenderer(document.getElementById('stage')!, project,
      asset => `/api/thumbnail/export/asset?${new URLSearchParams({ id: project, job: thumbnailJob, asset })}`);
    window.harnessNativeFrame = async frame => { await renderer.render(plan, frame); };
    window.harnessNativeReady = true; return;
  }
  if (!project || !job) throw new Error('書き出しジョブが指定されていません');
  // The export runner names the frames to keep per source (retain=N). Without it the
  // export page keeps the earlier behaviour: byte budget only, every source kept open.
  const sources = exportRendererOptions(parseRetainFrames(query.get('retain')));
  const params = new URLSearchParams({ id: project, job });
  const response = await fetch(`/api/sequence/export/input?${params}`);
  const input = await response.json(); if (!response.ok) throw new Error(input.error ?? '固定した編集版を読み込めません');
  const plan = new ScenePlan(input.document as SequenceDocument), stage = document.getElementById('stage')!;
  // Every export frame in new elements: what Chromium drew before must not change it (sceneRenderer freshTree).
  const renderer = new NativeSceneRenderer(stage, project, (asset, component) => `/api/sequence/export/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: project, job, asset })}`, sources, { freshTree: true });
  window.harnessNativeFrame = async frame => { await renderer.render(plan, frame); };
  window.harnessNativeDecodeStats = () => structuredClone(nativeDecodeStats);
  window.harnessNativeFrameSamples = () => renderer.frameSamples();
  window.harnessNativeFrameTiming = () => renderer.lastDrawTiming();
  window.harnessNativeReady = true;
}
void initialize().catch(error => { window.harnessNativeFailure = previewFailure(error); window.harnessNativeError = window.harnessNativeFailure.message; });
