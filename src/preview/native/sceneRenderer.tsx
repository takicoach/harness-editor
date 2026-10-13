import React, { Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CaptureFrameProvider, setStaticFileResolver } from '../../captureRuntime';
import { CaptureTelopLayer, CaptureTitleLayer } from '../../capturePage/layers';
import { animStyleAt, DEFAULT_FADE } from '../../core/elementAnim';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { ScenePlan, type PlannedVisual } from '../../core/sequence/scenePlan';
import { timeNumber } from '../../core/sequence/time';
import { pickTelopExport, type TelopComponent } from '../loadTelopComponent';
import { pickInsertImageExport, type InsertImageComponent } from '../loadInsertImageComponent';
import { NativeCompositor } from './compositor';
import { Mp4FrameSource, httpByteSource, nativeDecodeStats, type AcquiredFrame } from './mp4FrameSource';
import { sourcesToRelease, videoSourceKey, videoSourceUses, type FrameSpan, type NativeFrameSample, type RendererSourceOptions } from './exportSourceRelease';
import { parseCube, type CubeLut } from './lut';
import { NativeText } from './NativeText';
import { NativeImage } from './NativeImage';
import { NativeShape } from './NativeShape';
import {activeTextAppearance,textComponentId} from '../../core/sequence/textStyle';
import type { TelopSegment } from '../../core/types';
import {fitDecodedVideo,fitDecodedImage,unplaceBorderBox,staticTextBorderSize,assertRenderableGraphicPosition,measurableGraphicBox,type LocalVisualBounds,type RenderedSceneGeometry,type RenderedVideoGeometry} from './renderGeometry';
import {textGeometryIssue} from './textGeometry';
import {titleGeometryIssue} from './titleGeometry';
import { previewResourceError } from './previewError';
import { measureLegacyVisuals, type LegacyMeasurementRequest, type LegacyMeasurementSnapshot } from './legacyMeasurement';
import { applyLegacyCaptionFont } from '../legacyCaptionFont';
import {expandBounds,textInkInsets} from '../../core/textDecoration';

export function sequenceAssetUrl(projectId: string, assetId: string, component = false): string {
  return `/api/sequence/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: projectId, asset: assetId })}`;
}
const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
/** 利用者の部品（自作テロップ・画像部品・旧形式の部品ファイル）へ渡す入れ子のデータ。プレビューは親の計画をそのまま受け取るので（設計 §2-5）、
 * 部品が instanceof Array などで判定しても今までどおり動くよう、この画面のレルムの物に複製して渡す。元はクリップの変更不可の値なので、値ごと（＝クリップごと）に1回だけ複製し、
 * 変更不可も保つ。この画面の計画（書き出し・外からの文書）は複製しない。 */
const ownRealm=new WeakMap<object,object>();
function ownRealmValue<T>(value:T):T {
  if(!value||typeof value!=='object'||value instanceof Object)return value;
  let copy=ownRealm.get(value);if(!copy){copy=deepFreeze(structuredClone(value));ownRealm.set(value,copy);}return copy as T;
}
function deepFreeze<T>(value:T):T {
  if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}
  return value;
}
class DrawingBoundary extends Component<{ children: ReactNode; failed: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.failed(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Same explicit-frame DOM/GPU renderer for interactive playback and reference export. */
export class NativeSceneRenderer {
  private readonly root: Root;
  private readonly mount = document.createElement('div');
  private readonly drawingRoot = this.mount.attachShadow({ mode: 'open' });
  private readonly scratch = document.createElement('canvas');
  private readonly gpu: NativeCompositor;
  private decoders = new Map<string, Promise<Mp4FrameSource>>();
  /** Opened sources of the decoders Map, for releasing them (export only). */
  private opened = new Map<string, Mp4FrameSource>();
  private uses: {plan: ScenePlan; spans: Map<string, FrameSpan[]>} | undefined;
  private bundles = new Map<string, Promise<Record<string, unknown>>>();
  private luts = new Map<string, Promise<CubeLut>>();
  private buffers = new Map<string, HTMLCanvasElement>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private disposed = false;
  private drawingError: Error | undefined;
  private errorRevision = -1;
  private boundaryGeneration = 0;
  /** Export only (options.freshTree): every draw mounts a new tree. */
  private draws = 0;
  /** Measurement only (renderPage harnessNativeFrameTiming): where the last draw spent its time, in ms per phase. */
  private lastTiming: Record<string, number> | null = null;
  lastDrawTiming(): Record<string, number> | null { return this.lastTiming; }
  private restoreCaptionFonts: () => void = () => {};
  private renderedGeometry:RenderedSceneGeometry|null=null;
  private measurement: {geometry:RenderedSceneGeometry;visuals:readonly PlannedVisual[];isCurrent:()=>boolean}|null=null;
  geometry():RenderedSceneGeometry|null {return this.renderedGeometry;}
  private samples: NativeFrameSample[] = [];
  /** The source sample each video layer of the last drawn frame used, in layer order (export measurement). */
  frameSamples(): NativeFrameSample[] { return structuredClone(this.samples); }
  measureLegacy(request:LegacyMeasurementRequest):LegacyMeasurementSnapshot|null {
    const snapshot=this.measurement;
    if(this.disposed||!snapshot||!snapshot.isCurrent())return null;
    return measureLegacyVisuals(this.drawingRoot,this.mount,snapshot.geometry,snapshot.visuals,request);
  }

  constructor(readonly container: HTMLElement, readonly projectId: string,
    private readonly assetUrl: (assetId: string, component?: boolean) => string = (assetId, component) => sequenceAssetUrl(projectId, assetId, component),
    /** Export only (renderPage with retain=N): per-source retention and releasing sources.
     * The preview passes nothing and keeps the default byte budget and every source open. */
    private readonly sources: RendererSourceOptions = {},
    /** freshTree (export only): draw every frame into newly created elements. Chromium draws an element that has
     * changed (opacity, translate) differently ever after: text that faded in keeps other edge pixels than the same
     * text drawn on a page that never saw the fade, by up to 2 steps, and an icon in a panel moved by a pixel (up to
     * 180). An export frame must depend on its frame number only, not on the frames this page drew before (parallel
     * workers draw from other places in the sequence). The preview
     * keeps its elements between frames. */
    private readonly options: { freshTree?: boolean } = {}) {
    this.mount.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#000;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility';
    container.appendChild(this.mount); this.root = createRoot(this.drawingRoot); this.gpu = new NativeCompositor(this.scratch);
  }
  private asset(document: SequenceDocument, id: string): SequenceAsset {
    const asset = document.assets.find(a => a.id === id); if (!asset) throw new Error('描画する素材が見つかりません'); return asset;
  }
  private async bundle(id: string): Promise<Record<string, unknown>> {
    let bundle = this.bundles.get(id);
    if (!bundle) {
      bundle = (async () => {
        const response = await fetch(this.assetUrl(id, true), { signal: this.abort.signal });
        if (!response.ok) throw previewResourceError('保存した描画部品を読み込めません', response.status, 'component', this.assetUrl(id, true));
        const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
        try { return await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
      })();
      // A transient failure (network blip, dev HMR racing the blob import, ...)
      // must not stay cached: the Map is keyed by componentAssetId, so every
      // later frame for every telop clip on that style would replay the same
      // rejection forever, freezing the preview on its last good frame while
      // the document (and the caption panel's text) keeps changing underneath
      // it. Evict on rejection so the next render retries the fetch.
      bundle.catch(() => { if (this.bundles.get(id) === bundle) this.bundles.delete(id); });
      this.bundles.set(id, bundle);
    }
    return bundle;
  }
  private async frame(plan:ScenePlan, visual: PlannedVisual): Promise<AcquiredFrame> {
    const document=plan.document;
    const content = visual.clip.content; if (content.kind !== 'video') throw new Error('映像クリップが必要です');
    const asset = this.asset(document, content.assetId), key = videoSourceKey(asset, content.streamIndex);
    let decoder = this.decoders.get(key);
    if (!decoder) {
      const index = asset.streams.filter(s => s.kind === 'video').findIndex(s => s.index === content.streamIndex);
      const originalUrl=this.assetUrl(asset.id);
      // Export/legacy URLs keep their original source. Only native preview opts in.
      const url=originalUrl.startsWith('/api/sequence/asset?')?originalUrl+'&preview=1':originalUrl;
      const retention = this.sources.retention;
      const opening: Promise<Mp4FrameSource> = httpByteSource(url, this.abort.signal)
        .then(bytes => retention ? Mp4FrameSource.open(bytes, index, retention) : Mp4FrameSource.open(bytes, index))
        .then(source => {
          nativeDecodeStats.sourcesOpened++;
          if (this.decoders.get(key) === opening && !this.disposed) this.opened.set(key, source);
          return source;
        });
      decoder = opening; this.decoders.set(key, decoder);
    }
    return (await decoder).acquire(visual.sourceTime!, content.endBehavior === 'hold', plan.videoSourceWindow(visual.clip.id));
  }
  render(plan: ScenePlan, frame: number, bypassLut = false, isCurrent: () => boolean = () => true): Promise<void> {
    if(isCurrent())this.measurement=null;
    const task = this.queue.then(() => isCurrent() ? this.draw(plan, frame, bypassLut, isCurrent) : undefined); this.queue = task.catch(() => undefined); return task;
  }
  private async draw(plan: ScenePlan, frame: number, bypassLut: boolean, isCurrent: () => boolean): Promise<void> {
    if (this.disposed) throw new Error('プレビューは閉じられています');
    this.samples = [];
    const marks: Record<string, number> = {}; let mark = performance.now();
    const lap = (name: string) => { const now = performance.now(); marks[name] = now - mark; mark = now; };
    const doc = plan.document, scene = plan.frame(frame), { width, height } = doc.resolution;
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height !== height) this.scratch.height = height;
    if (this.errorRevision !== doc.revision) { this.drawingError = undefined; this.errorRevision = doc.revision; }
    else if(this.drawingError){this.drawingError=undefined;this.boundaryGeneration++;}
    this.container.style.width = `${width}px`; this.container.style.height = `${height}px`;
    const renderConfig = doc.rendering;
    const InsertImage: InsertImageComponent | undefined = renderConfig?.imageComponentAssetId ? pickInsertImageExport(await this.bundle(renderConfig.imageComponentAssetId)) : undefined;
    const acquired: AcquiredFrame[] = [], nodes: ReactNode[] = [], used = new Set<string>(),videos:RenderedVideoGeometry[]=[];
    const legacyTextIds = new Set<string>();
    try {
      const videoVisuals = scene.visuals.filter(visual => visual.clip.content.kind === 'video');
      const videoFrames = new Map<string, AcquiredFrame>();
      const failures: Array<{ index: number; error: unknown }> = [];
      let nextVideo = 0;
      const acquireNext = async () => {
        while (!failures.length && !this.disposed && isCurrent()) {
          const index = nextVideo++, visual = videoVisuals[index];
          if (!visual) return;
          try {
            const decoded = await this.frame(plan, visual);
            acquired.push(decoded); videoFrames.set(visual.clip.id, decoded);
          } catch (error) { failures.push({ index, error }); }
        }
      };
      // Independent sources may decode together. Always await both workers so
      // late frames are owned before the common finally closes them on failure.
      // Bound the work even when a document has many simultaneous video layers.
      await Promise.all(Array.from({ length: Math.min(2, videoVisuals.length) }, acquireNext));
      lap('decodeMs');
      if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0]!.error;
      if (this.disposed) throw new Error('プレビューは閉じられています');
      if (!isCurrent()) return;
      this.samples = videoVisuals.flatMap(visual => {
        const decoded = videoFrames.get(visual.clip.id), content = visual.clip.content;
        return decoded && content.kind === 'video' ? [{ clip: visual.clip.id, source: videoSourceKey(this.asset(doc, content.assetId), content.streamIndex),
          sample: decoded.identity.sample, pts: structuredClone(decoded.identity.pts) }] : [];
      });
      for (const visual of scene.visuals) {
        const { clip, effectFrame, effectDuration, transform } = visual, content = clip.content;
        if (used.has(clip.id)) continue;
        let node: ReactNode;
        if (content.kind === 'video') {
          const transition = scene.transitions.find(t => t.transition.outClipId === clip.id && t.transition.inClipId);
          const incoming = transition && scene.visuals.find(v => v.clip.id === transition.transition.inClipId);
          const members = incoming ? [visual, incoming] : [visual];
          let canvas = this.buffers.get(clip.id);
          if (!canvas) { canvas = document.createElement('canvas'); this.buffers.set(clip.id, canvas); }
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d'); if (!context) throw new Error('映像の表示面を作れません');
          for (const [index, member] of members.entries()) {
            const media = member.clip.content; if (media.kind !== 'video') throw new Error('映像以外の転換にはまだ対応していません');
            used.add(member.clip.id);
            const decoded = videoFrames.get(member.clip.id);
            if (!decoded) throw new Error('描画する映像フレームがありません');
            const stream = this.asset(doc, media.assetId).streams.find(s => s.index === media.streamIndex)!;
            const angle = -(stream.rotation ?? 0);
            const fittedSize=fitDecodedVideo(decoded.frame,stream.sampleAspectRatio?timeNumber(stream.sampleAspectRatio):1,angle,doc.resolution);
            const w = fittedSize.width * member.transform.scale, h = fittedSize.height * member.transform.scale;
            videos.push({clipId:member.clip.id,source:{displayWidth:decoded.frame.displayWidth,displayHeight:decoded.frame.displayHeight,sampleAspectRatio:stream.sampleAspectRatio?timeNumber(stream.sampleAspectRatio):1,rotation:stream.rotation??0},
              fittedSize,transform:{...member.transform},
              bounds:{x:(width-w)/2+member.transform.x*width/2,y:(height-h)/2+member.transform.y*height/2,width:w,height:h,rotation:angle+member.transform.rotation},
              transition:scene.transitions.some(item=>item.transition.outClipId===member.clip.id||item.transition.inClipId===member.clip.id),
              animated:[member.clip.visual?.enter,member.clip.visual?.exit].some(item=>item&&item.kind!=='none')});
            let lut: { table: CubeLut; intensity: number } | undefined;
            if (!bypassLut && member.clip.visual?.lut) {
              const value = member.clip.visual.lut;
              let table = this.luts.get(value.assetId);
              if (!table) {
                table = fetch(this.assetUrl(value.assetId), { signal: this.abort.signal }).then(async response => {
                  if (!response.ok) throw previewResourceError('適用したLUTを読み込めません', response.status, 'asset', this.assetUrl(value.assetId)); return parseCube(await response.text());
                }); this.luts.set(value.assetId, table);
              }
              lut = { table: await table, intensity: value.intensity };
            }
            this.gpu.render([{ id: member.clip.id, source: decoded.frame, x: (width - w) / 2 + member.transform.x * width / 2,
              y: (height - h) / 2 + member.transform.y * height / 2, width: w, height: h,
              rotation: angle + member.transform.rotation, flipH: member.transform.flipH, flipV: member.transform.flipV,
              opacity: member.transform.opacity, grade: member.clip.visual?.colorGrade, lut }], [0, 0, 0], 0);
            context.save();
            if (transition && incoming) {
              const p = transition.progress, kind = transition.transition.kind;
              if (kind === 'crossfade') { context.globalCompositeOperation = 'lighter'; context.globalAlpha = index ? p : 1 - p; }
              else if (kind.startsWith('slide')) {
                const direction = kind.slice(5).toLowerCase(), sign = direction === 'right' || direction === 'down' ? -1 : 1;
                const displacement = (index ? 1 - p : -p) * sign;
                context.translate(direction === 'left' || direction === 'right' ? displacement * width : 0,
                  direction === 'up' || direction === 'down' ? displacement * height : 0);
              } else if (kind.startsWith('wipe') && index) {
                const direction = kind.slice(4).toLowerCase(); context.beginPath();
                if (direction === 'left') context.rect(width * (1 - p), 0, width * p, height);
                else if (direction === 'right') context.rect(0, 0, width * p, height);
                else if (direction === 'up') context.rect(0, height * (1 - p), width, height * p);
                else context.rect(0, 0, width, height * p);
                context.clip();
              }
            }
            context.drawImage(this.scratch, 0, 0); context.restore();
          }
          const snapshot = canvas;
          const colorFade = scene.transitions.find(t => t.transition.outClipId === clip.id && !t.transition.inClipId);
          if (colorFade) {
            context.save(); context.fillStyle = colorFade.transition.kind === 'fadeWhite' ? '#ffffff' : '#000000';
            context.globalAlpha = colorFade.transition.edge === 'in' ? 1 - colorFade.progress : colorFade.progress;
            context.fillRect(0, 0, width, height); context.restore();
          }
          const animation = clip.visual?.enter || clip.visual?.exit
            ? animStyleAt(effectFrame, effectDuration, clip.visual.enter ?? DEFAULT_FADE, clip.visual.exit ?? DEFAULT_FADE) : { opacity: 1, transform: '' };
          node = <canvas width={width} height={height} style={{ ...fill, ...animation, ...(clip.visual?.look?.blur ? { filter: `blur(${clip.visual.look.blur}px)` } : {}) }} ref={target => {
            const ctx = target?.getContext('2d'); if (ctx) { ctx.clearRect(0, 0, width, height); ctx.drawImage(snapshot, 0, 0); }
          }} />;
        } else if (content.kind === 'telop') {
          const appearance = activeTextAppearance(content),componentId=textComponentId(doc,content);
          const Text: TelopComponent | undefined = appearance ? ({ segment }) => <NativeText segment={segment as TelopSegment} appearance={appearance} />
            : componentId?pickTelopExport(await this.bundle(componentId)):undefined;
          if (!Text) throw new Error('字幕の描画部品がありません');
          if (!appearance && componentId && this.asset(doc, componentId).textStyleCatalog?.source !== 'builtin') legacyTextIds.add(clip.id);
          node = <CaptureTelopLayer Telop={Text} telops={[{ ...ownRealmValue(content.data), id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration }]} />;
        } else if (content.kind === 'title') {
          node = <CaptureTitleLayer titles={[{ ...ownRealmValue(content.data), id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration }]} titleStyle={ownRealmValue(content.style)} animate={titleGeometryIssue(clip.visual)==='inner-animation'} measureTitleBox />;
        } else if (content.kind === 'shape') node = <NativeShape visual={visual} width={width} height={height} />;
        else if (content.kind === 'scene-fade') node = <div style={{ ...fill, background: content.color, opacity: transform.opacity }} />;
        else if (content.kind === 'image') {
          const imageUrl = this.assetUrl(content.assetId);
          node = InsertImage ? <InsertImage segment={{ id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration, file: this.asset(doc, content.assetId).name, imageUrl,
            type: content.style ?? 'plain', position: { x: transform.x, y: transform.y }, scale: transform.scale,
            opacity: transform.opacity, rotation: transform.rotation, enter: ownRealmValue(clip.visual?.enter), exit: ownRealmValue(clip.visual?.exit) }} />
            : <NativeImage visual={visual} src={imageUrl}/>;
        }
        if(content.kind==='telop'||content.kind==='title'||content.kind==='shape') {
          assertRenderableGraphicPosition(transform,{width,height});
          const explicit=clip.visual?.enter||clip.visual?.exit;
          const animation=explicit?animStyleAt(effectFrame,effectDuration,clip.visual?.enter??{kind:'none',frames:0},clip.visual?.exit??{kind:'none',frames:0}):undefined;
          node=<div data-native-placement style={{...fill,opacity:transform.opacity,transform:`translate(${transform.x*50}%, ${transform.y*50}%) rotate(${transform.rotation}deg) scale(${transform.scale*(transform.flipH?-1:1)}, ${transform.scale*(transform.flipV?-1:1)})`}}>
            {animation?<div data-native-animation style={{...fill,...animation}}>{node}</div>:node}
          </div>;
        }
        nodes.push(<div key={clip.id} data-native-clip={clip.id} style={{ ...fill, isolation: 'isolate', pointerEvents: 'none' }}>
          <CaptureFrameProvider frame={effectFrame} videoConfig={{ width, height, fps: timeNumber(doc.fps), durationInFrames: effectDuration }}>{node}</CaptureFrameProvider>
        </div>);
      }
      if (this.disposed) throw new Error('プレビューは閉じられています');
      if (!isCurrent()) return;
      setStaticFileResolver(name => {
        const key = decodeURIComponent(name).replace(/^\/+/, ''), asset = renderConfig?.staticFiles?.[key];
        if (!asset) throw new Error(`保存されていない部品素材です: ${key}`);
        return this.assetUrl(asset);
      });
      this.restoreCaptionFonts(); this.restoreCaptionFonts = () => {};
      lap('composeMs');
      const tree = this.options.freshTree ? `:${this.draws++}` : '';
      flushSync(() => this.root.render(<DrawingBoundary key={`${doc.revision}:${this.boundaryGeneration}${tree}`} failed={error => { this.drawingError = error; }}>
        <style>{'* { box-sizing: border-box; }'}</style>
        <div style={{ ...fill, background: doc.background, overflow: 'hidden' }}>{nodes}</div>
      </DrawingBoundary>));
      if (this.drawingError) throw this.drawingError;
      lap('reactMs');
      const fontCleanups = Array.from(this.drawingRoot.querySelectorAll('[data-native-clip]'))
        .filter(element => legacyTextIds.has(element.getAttribute('data-native-clip')!)).map(applyLegacyCaptionFont);
      this.restoreCaptionFonts = () => fontCleanups.forEach(cleanup => cleanup());
      await document.fonts.ready;
      await Promise.all(Array.from(this.drawingRoot.querySelectorAll('img')).map(async img => {
        try { await img.decode(); }
        catch (error) {
          // Image.decode does not expose HTTP status. Probe only a failed legacy
          // resource, never external component URLs or successful image loads.
          const url = new URL(img.currentSrc || img.src, location.href);
          if (url.origin === location.origin && url.pathname === '/api/legacy-preview/asset') {
            const response = await fetch(url.href, { headers: { Range: 'bytes=0-0' }, signal: this.abort.signal });
            await response.body?.cancel();
            if (!response.ok) throw previewResourceError('画像素材を読み込めません', response.status, 'asset', url.href);
          }
          throw error;
        }
      }));
      lap('assetsMs');
      if(!isCurrent())return;
      const images:RenderedVideoGeometry[]=[];
      if(!InsertImage)for(const img of this.drawingRoot.querySelectorAll<HTMLImageElement>('img[data-native-plain-image]')){
        const visual=scene.visuals.find(item=>item.clip.id===img.dataset.nativePlainImage);
        if(!visual||visual.clip.content.kind!=='image'||(visual.clip.content.style??'plain')!=='plain')continue;
        const style=getComputedStyle(img),transform=visual.transform;
        const fittedSize=fitDecodedImage({width:img.naturalWidth,height:img.naturalHeight},
          {width:parseFloat(style.width),height:parseFloat(style.height)},transform.scale);
        const w=fittedSize.width*transform.scale,h=fittedSize.height*transform.scale;
        images.push({clipId:visual.clip.id,source:{displayWidth:img.naturalWidth,displayHeight:img.naturalHeight,sampleAspectRatio:1,rotation:0},
          fittedSize,transform:{...transform},bounds:{x:(width-w)/2+transform.x*width/2,y:(height-h)/2+transform.y*height/2,width:w,height:h,rotation:transform.rotation},
          transition:scene.transitions.some(item=>item.transition.outClipId===visual.clip.id||item.transition.inClipId===visual.clip.id),
          animated:[visual.clip.visual?.enter,visual.clip.visual?.exit].some(item=>item&&item.kind!=='none')});
      }
      const elements:RenderedVideoGeometry[]=[],rootBounds=this.mount.getBoundingClientRect();
      for(const container of this.drawingRoot.querySelectorAll<HTMLElement>('[data-native-clip]')){
        const visual=scene.visuals.find(item=>item.clip.id===container.dataset.nativeClip);
        if(!visual)continue;
        const content=visual.clip.content,transform=visual.transform;
        const animated=[visual.clip.visual?.enter,visual.clip.visual?.exit].some(item=>item&&item.kind!=='none');
        let localBounds:LocalVisualBounds|undefined;
        if(content.kind==='telop'&&!textGeometryIssue(content)&&!animated){
          const text=container.querySelector<HTMLElement>('[data-native-text-box]');
          if(text){
            const box=text.getBoundingClientRect(),style=getComputedStyle(text);
            if(!measurableGraphicBox(box,rootBounds))continue;
            const inner=text.closest<HTMLElement>('[data-sme-kind="telop"]');
            if(!inner)continue;
            const cssTransform=getComputedStyle(inner).transform;
            const size=staticTextBorderSize({width:parseFloat(style.width),height:parseFloat(style.height)},
              new DOMMatrixReadOnly(cssTransform==='none'?undefined:cssTransform));
            if(!size||![rootBounds.width,rootBounds.height].every(value=>Number.isFinite(value)&&value>0))continue;
            // Preserve static inner translation/scale in the local content box.
            // Only the outer placement is removed from the measured center.
            localBounds=unplaceBorderBox({x:(box.x+box.width/2-rootBounds.x)*width/rootBounds.width,
              y:(box.y+box.height/2-rootBounds.y)*height/rootBounds.height},
              size,{width,height},transform);
            // 縁取り・影・傾きは帯の外へはみ出すので選択枠にも含める（描画と同じ関数で求める）。
            const appearance=activeTextAppearance(content);
            if(localBounds&&appearance){
              const unscaled={width:parseFloat(style.width),height:parseFloat(style.height)},factor=size.width/unscaled.width,insets=textInkInsets(appearance,unscaled);
              localBounds=expandBounds(localBounds,{top:insets.top*factor,right:insets.right*factor,bottom:insets.bottom*factor,left:insets.left*factor});
            }
          }
        }else if(content.kind==='title'&&!titleGeometryIssue(visual.clip.visual)){
          // Measure the background band's border box, not the skewed text or
          // its shadow. Top/left and padding are already in its actual center.
          const title=container.querySelector<HTMLElement>('[data-native-title-box]');
          if(title){
            const box=title.getBoundingClientRect(),style=getComputedStyle(title);
            if(!measurableGraphicBox(box,rootBounds)||![rootBounds.width,rootBounds.height].every(value=>Number.isFinite(value)&&value>0))continue;
            // The renderer's shadow-root reset sets border-box, so computed
            // width/height already include the band's 8px/5px padding.
            localBounds=unplaceBorderBox({x:(box.x+box.width/2-rootBounds.x)*width/rootBounds.width,
              y:(box.y+box.height/2-rootBounds.y)*height/rootBounds.height},
              {width:parseFloat(style.width),height:parseFloat(style.height)},{width,height},transform);
          }
        }else if(content.kind==='shape'&&(content.data.kind==='rect'||content.data.kind==='ellipse'||content.data.kind==='triangle')){
          const shape=container.querySelector<SVGGraphicsElement>('[data-native-shape-box]');
          if(shape){
            if(!measurableGraphicBox(shape.getBoundingClientRect(),rootBounds))continue;
            const box=shape.getBBox(),stroke=parseFloat(getComputedStyle(shape).strokeWidth);
            // SVG getBBox excludes stroke. Round joins/ellipse extend by half its width.
            if(box.width>0&&box.height>0)localBounds={x:box.x-stroke/2,y:box.y-stroke/2,width:box.width+stroke,height:box.height+stroke};
          }
        }
        if(!localBounds)continue;
        const angle=transform.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
        const lx=(localBounds.x+localBounds.width/2-width/2)*transform.scale*(transform.flipH?-1:1);
        const ly=(localBounds.y+localBounds.height/2-height/2)*transform.scale*(transform.flipV?-1:1);
        const w=localBounds.width*transform.scale,h=localBounds.height*transform.scale;
        elements.push({clipId:visual.clip.id,source:{displayWidth:width,displayHeight:height,sampleAspectRatio:1,rotation:0},
          fittedSize:{width:localBounds.width,height:localBounds.height},localBounds,transform:{...transform},
          bounds:{x:width/2+transform.x*width/2+c*lx-s*ly-w/2,y:height/2+transform.y*height/2+s*lx+c*ly-h/2,width:w,height:h,rotation:transform.rotation},
          transition:scene.transitions.some(item=>item.transition.outClipId===visual.clip.id||item.transition.inClipId===visual.clip.id),
          animated});
      }
      this.renderedGeometry={documentId:doc.id,revision:doc.revision,frame,resolution:{width,height},videos,images,elements};
      this.measurement={geometry:this.renderedGeometry,visuals:scene.visuals,isCurrent};
      lap('measureMs'); this.lastTiming = marks;
      this.mount.dataset.nativeFrame = String(frame); this.mount.dataset.nativeRevision = String(doc.revision); this.mount.dataset.nativeLutBypass = String(bypassLut);
      for (const key of this.buffers.keys()) if (!used.has(key)) this.buffers.delete(key);
    } finally {
      for (const decoded of acquired) decoded.frame.close();
      // Every acquire of this frame has settled and its clone is closed.
      this.releaseSources(plan, frame);
    }
  }
  /** Export only: dispose the sources sourcesToRelease names; a later request opens them again. */
  private releaseSources(plan: ScenePlan, frame: number): void {
    const release = this.sources.release;
    if (!release || this.disposed || !this.opened.size) return;
    if (this.uses?.plan !== plan) this.uses = { plan, spans: videoSourceUses(plan.document) };
    const open = [...this.opened].map(([key, source]) => ({ key, bytes: source.retainedBytes }));
    for (const { key, reason } of sourcesToRelease(frame, open, this.uses.spans, release.totalBytes)) {
      const source = this.opened.get(key)!;
      this.opened.delete(key); this.decoders.delete(key);
      source.dispose(); nativeDecodeStats.sourcesReleased[reason]++;
    }
  }
  dispose(): void {
    this.restoreCaptionFonts(); this.restoreCaptionFonts = () => {};
    this.disposed = true; this.abort.abort();
    for (const decoder of this.decoders.values()) void decoder.then(value => value.dispose(), () => undefined);
    this.opened.clear();
    this.gpu.dispose(); this.buffers.clear();
    queueMicrotask(() => { this.root.unmount(); this.mount.remove(); });
  }
  clear(): void { this.restoreCaptionFonts();this.restoreCaptionFonts=()=>{};this.measurement=null;this.renderedGeometry=null;flushSync(() => this.root.render(null)); delete this.mount.dataset.nativeFrame; }
}
