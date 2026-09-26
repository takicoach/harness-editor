import React, { Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CaptureFrameProvider, setStaticFileResolver } from '../../captureRuntime';
import { CaptureTelopLayer, CaptureTitleLayer } from '../../capturePage/layers';
import { shapeSvgGeometry, thicknessToPx, fadeOpacity } from '../../core/shapeStyle';
import { angleDecorations, trianglePoints } from '../../core/shapeGeometry';
import { animStyleAt, DEFAULT_FADE } from '../../core/elementAnim';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { ScenePlan, type PlannedVisual } from '../../core/sequence/scenePlan';
import { timeNumber } from '../../core/sequence/time';
import { pickTelopExport, type TelopComponent } from '../loadTelopComponent';
import { pickInsertImageExport, type InsertImageComponent } from '../loadInsertImageComponent';
import { NativeCompositor } from './compositor';
import { Mp4FrameSource, httpByteSource, type AcquiredFrame } from './mp4FrameSource';
import { parseCube, type CubeLut } from './lut';
import { NativeText } from './NativeText';
import { NativeImage } from './NativeImage';
import {activeTextAppearance,textComponentId} from '../../core/sequence/textStyle';
import type { TelopSegment } from '../../core/types';
import {fitDecodedVideo,fitDecodedImage,unplaceBorderBox,staticTextBorderSize,assertRenderableGraphicPosition,measurableGraphicBox,type LocalVisualBounds,type RenderedSceneGeometry,type RenderedVideoGeometry} from './renderGeometry';
import {textGeometryIssue} from './textGeometry';
import {titleGeometryIssue} from './titleGeometry';
import { previewResourceError } from './previewError';
import { measureLegacyVisuals, type LegacyMeasurementRequest, type LegacyMeasurementSnapshot } from './legacyMeasurement';
import { applyLegacyCaptionFont } from '../legacyCaptionFont';

export function sequenceAssetUrl(projectId: string, assetId: string, component = false): string {
  return `/api/sequence/${component ? 'component' : 'asset'}?${new URLSearchParams({ id: projectId, asset: assetId })}`;
}
const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
class DrawingBoundary extends Component<{ children: ReactNode; failed: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.failed(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function Shape({ visual, width, height }: { visual: PlannedVisual; width: number; height: number }) {
  if (visual.clip.content.kind !== 'shape') return null;
  const shape = visual.clip.content.data, g = shapeSvgGeometry(shape, width, height), stroke = thicknessToPx(shape.thickness, height);
  const arrow = `native-arrow-${visual.clip.id}`;
  const explicit=visual.clip.visual?.enter||visual.clip.visual?.exit;
  const opacity=(shape.opacity ?? 1) * (explicit?1:fadeOpacity(visual.effectFrame, visual.effectDuration, 8));
  let body: ReactNode;
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    body = <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={shape.color} strokeWidth={stroke} strokeLinecap="round" markerEnd={shape.kind === 'arrow' ? `url(#${arrow})` : undefined} />;
  } else if (shape.kind === 'rect') {
    body = <rect data-native-shape-box x={g.rectX} y={g.rectY} width={g.rectW} height={g.rectH} stroke={shape.color} strokeWidth={stroke} fill="none" strokeLinejoin="round" />;
  } else if (shape.kind === 'triangle') {
    const points = trianglePoints(g.x1, g.y1, g.x2, g.y2);
    body = <polygon data-native-shape-box points={points.map(p => `${p.x},${p.y}`).join(' ')} stroke={shape.color} strokeWidth={stroke} fill="none" strokeLinejoin="round" />;
  } else if (shape.kind === 'angle') {
    // 装飾の式は core/shapeGeometry が正本。書き出し側（server/shapeRaster）と同じ関数を呼ぶ。
    const { p1, p2, p3, arcPath, arcStroke, label, fontSize, degrees } = angleDecorations(shape, width, height, stroke);
    body = <g>
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={shape.color} strokeWidth={stroke} strokeLinecap="round" />
      <line x1={p1.x} y1={p1.y} x2={p3.x} y2={p3.y} stroke={shape.color} strokeWidth={stroke} strokeLinecap="round" />
      <path d={arcPath} stroke={shape.color} strokeWidth={arcStroke} fill="none" />
      <text data-native-angle-readout x={label.x} y={label.y} fill={shape.color} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: `${fontSize}px`, fontWeight: 700 }}>
        {degrees.toFixed(1)}°
      </text>
    </g>;
  } else {
    body = <ellipse data-native-shape-box cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} stroke={shape.color} strokeWidth={stroke} fill="none" />;
  }
  return <svg viewBox={`0 0 ${width} ${height}`} style={{ ...fill, opacity }}>
    <defs><marker id={arrow} markerWidth="3" markerHeight="3" refX="3" refY="1.5" orient="auto"><polygon points="0 0, 3 1.5, 0 3" fill={shape.color} /></marker></defs>
    {body}
  </svg>;
}

/** Same explicit-frame DOM/GPU renderer for interactive playback and reference export. */
export class NativeSceneRenderer {
  private readonly root: Root;
  private readonly mount = document.createElement('div');
  private readonly drawingRoot = this.mount.attachShadow({ mode: 'open' });
  private readonly scratch = document.createElement('canvas');
  private readonly gpu: NativeCompositor;
  private decoders = new Map<string, Promise<Mp4FrameSource>>();
  private bundles = new Map<string, Promise<Record<string, unknown>>>();
  private luts = new Map<string, Promise<CubeLut>>();
  private buffers = new Map<string, HTMLCanvasElement>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private disposed = false;
  private drawingError: Error | undefined;
  private errorRevision = -1;
  private boundaryGeneration = 0;
  private restoreCaptionFonts: () => void = () => {};
  private renderedGeometry:RenderedSceneGeometry|null=null;
  private measurement: {geometry:RenderedSceneGeometry;visuals:readonly PlannedVisual[];isCurrent:()=>boolean}|null=null;
  geometry():RenderedSceneGeometry|null {return this.renderedGeometry;}
  measureLegacy(request:LegacyMeasurementRequest):LegacyMeasurementSnapshot|null {
    const snapshot=this.measurement;
    if(this.disposed||!snapshot||!snapshot.isCurrent())return null;
    return measureLegacyVisuals(this.drawingRoot,this.mount,snapshot.geometry,snapshot.visuals,request);
  }

  constructor(readonly container: HTMLElement, readonly projectId: string,
    private readonly assetUrl: (assetId: string, component?: boolean) => string = (assetId, component) => sequenceAssetUrl(projectId, assetId, component)) {
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
    const asset = this.asset(document, content.assetId), key = `${asset.fingerprint}:${content.streamIndex}`;
    let decoder = this.decoders.get(key);
    if (!decoder) {
      const index = asset.streams.filter(s => s.kind === 'video').findIndex(s => s.index === content.streamIndex);
      const originalUrl=this.assetUrl(asset.id);
      // Export/legacy URLs keep their original source. Only native preview opts in.
      const url=originalUrl.startsWith('/api/sequence/asset?')?originalUrl+'&preview=1':originalUrl;
      decoder = httpByteSource(url, this.abort.signal).then(bytes => Mp4FrameSource.open(bytes, index));
      this.decoders.set(key, decoder);
    }
    return (await decoder).acquire(visual.sourceTime!, content.endBehavior === 'hold', plan.videoSourceWindow(visual.clip.id));
  }
  render(plan: ScenePlan, frame: number, bypassLut = false, isCurrent: () => boolean = () => true): Promise<void> {
    if(isCurrent())this.measurement=null;
    const task = this.queue.then(() => isCurrent() ? this.draw(plan, frame, bypassLut, isCurrent) : undefined); this.queue = task.catch(() => undefined); return task;
  }
  private async draw(plan: ScenePlan, frame: number, bypassLut: boolean, isCurrent: () => boolean): Promise<void> {
    if (this.disposed) throw new Error('プレビューは閉じられています');
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
      if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0]!.error;
      if (this.disposed) throw new Error('プレビューは閉じられています');
      if (!isCurrent()) return;
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
          node = <canvas width={width} height={height} style={{ ...fill, ...animation }} ref={target => {
            const ctx = target?.getContext('2d'); if (ctx) { ctx.clearRect(0, 0, width, height); ctx.drawImage(snapshot, 0, 0); }
          }} />;
        } else if (content.kind === 'telop') {
          const appearance = activeTextAppearance(content),componentId=textComponentId(doc,content);
          const Text: TelopComponent | undefined = appearance ? ({ segment }) => <NativeText segment={segment as TelopSegment} appearance={appearance} />
            : componentId?pickTelopExport(await this.bundle(componentId)):undefined;
          if (!Text) throw new Error('字幕の描画部品がありません');
          if (!appearance && componentId && this.asset(doc, componentId).textStyleCatalog?.source !== 'builtin') legacyTextIds.add(clip.id);
          node = <CaptureTelopLayer Telop={Text} telops={[{ ...content.data, id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration }]} />;
        } else if (content.kind === 'title') {
          node = <CaptureTitleLayer titles={[{ ...content.data, id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration }]} titleStyle={content.style} animate={titleGeometryIssue(clip.visual)==='inner-animation'} measureTitleBox />;
        } else if (content.kind === 'shape') node = <Shape visual={visual} width={width} height={height} />;
        else if (content.kind === 'scene-fade') node = <div style={{ ...fill, background: content.color, opacity: transform.opacity }} />;
        else if (content.kind === 'image') {
          const imageUrl = this.assetUrl(content.assetId);
          node = InsertImage ? <InsertImage segment={{ id: content.legacyId ?? 1, startFrame: 0, endFrame: effectDuration, file: this.asset(doc, content.assetId).name, imageUrl,
            type: content.style ?? 'plain', position: { x: transform.x, y: transform.y }, scale: transform.scale,
            opacity: transform.opacity, rotation: transform.rotation, enter: clip.visual?.enter, exit: clip.visual?.exit }} />
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
      flushSync(() => this.root.render(<DrawingBoundary key={`${doc.revision}:${this.boundaryGeneration}`} failed={error => { this.drawingError = error; }}>
        <style>{'* { box-sizing: border-box; }'}</style>
        <div style={{ ...fill, background: doc.background, overflow: 'hidden' }}>{nodes}</div>
      </DrawingBoundary>));
      if (this.drawingError) throw this.drawingError;
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
      this.mount.dataset.nativeFrame = String(frame); this.mount.dataset.nativeRevision = String(doc.revision); this.mount.dataset.nativeLutBypass = String(bypassLut);
      for (const key of this.buffers.keys()) if (!used.has(key)) this.buffers.delete(key);
    } finally { for (const decoded of acquired) decoded.frame.close(); }
  }
  dispose(): void {
    this.restoreCaptionFonts(); this.restoreCaptionFonts = () => {};
    this.disposed = true; this.abort.abort();
    for (const decoder of this.decoders.values()) void decoder.then(value => value.dispose(), () => undefined);
    this.gpu.dispose(); this.buffers.clear();
    queueMicrotask(() => { this.root.unmount(); this.mount.remove(); });
  }
  clear(): void { this.restoreCaptionFonts();this.restoreCaptionFonts=()=>{};this.measurement=null;this.renderedGeometry=null;flushSync(() => this.root.render(null)); delete this.mount.dataset.nativeFrame; }
}
