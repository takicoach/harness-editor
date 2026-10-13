import { spawn } from 'node:child_process';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright-core';
import type { ScenePlan } from '../../core/sequence/scenePlan';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { resolveFfmpegBin, resolveFfprobeBin } from '../resolveFfmpeg';
import type { NativeExportStatus } from '../../shared/nativeExport';
import {nativeExportSettings,type NativeExportSettings} from '../../shared/nativeExport';
import {targetResolution,renderQualityCrf} from '../../shared/renderPreset';
import { writeSequenceAudio } from './exportAudio';
import { verifiedSequenceAssetPath,openSequenceAsset,type SequenceAssetLease } from './assets';
import {isSequenceReferenceFile} from './references';
import { readSequenceComponent } from './components';
import { probeExportFile, verifyExportProbe } from './exportVerification';
import { exportScratchFiles } from './exportRecords';
import { assertExportFreeSpace } from './exportSpace';
import { exportTraceSink, type ExportTraceSink } from './exportTrace';
import { EXPORT_RETAIN_FRAMES } from '../../preview/native/exportSourceRelease';
import { exportParallelSettings, renderExportFrames, type ExportWorker } from './exportParallel';
import { launchExportBrowser, type ExportBrowserLaunch } from './exportBrowser';

export interface ExportRunInput {
  plan: ScenePlan; projectDirectory: string; directory: string; origin: string; status: NativeExportStatus; signal: AbortSignal;settings?:NativeExportSettings;progress?():void;
}
export function nativeExportVideoSettings(source:{width:number;height:number},value?:NativeExportSettings){
  const settings=nativeExportSettings(value),outputResolution=targetResolution(source.width,source.height,settings.resolution);
  const resize=outputResolution.width!==source.width||outputResolution.height!==source.height?`${outputResolution.width}:${outputResolution.height}:flags=lanczos:`:'';
  return {settings,outputResolution,crf:renderQualityCrf(settings.quality),filter:`scale=${resize}out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709`};
}
/** The frames between the drawing surface and FFmpeg.
 * 'fast' (every export) captures JPEG at quality 100: the PNG compression, its 3× larger transfer and decoding
 * cost about 50 ms of CPU a frame. 'reference' (measurement baselines) captures PNG, RGB without loss. */
export type ExportFrameFormat = 'jpeg' | 'png';
export const EXPORT_JPEG_QUALITY = 100;
export function captureFrameFormat(mode: 'reference' | 'fast'): ExportFrameFormat {
  return mode === 'fast' ? 'jpeg' : 'png';
}
/** Chromium's JPEG is JFIF: YUV 4:2:0 in BT.601 at full range. Turn it back into RGB with exactly that matrix and
 * range, then apply the PNG path's filter unchanged. Converting YUV to RGB and RGB to YUV honours the matrix in every
 * FFmpeg version; a direct YUV-to-YUV matrix change does not in older swscale. Reading BT.709 here shifts saturated
 * colours by 10-20 (exportColor.e2e.test.ts). */
const JPEG_TO_RGB = 'scale=in_color_matrix=bt601:in_range=pc,format=rgb24';
/** FFmpeg arguments for intermediate frames (`input`) on stdin plus the prepared PCM file. `filter` takes RGB. */
export function encoderArguments({ fps, audioFile, filter, crf, output, input }: { fps: { num: number; den: number }; audioFile: string; filter: string; crf: number; output: string; input: ExportFrameFormat }): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', input === 'jpeg' ? 'mjpeg' : 'png', '-framerate', `${fps.num}/${fps.den}`, '-i', 'pipe:0',
    // Both inputs are finite. A -frames:v output cap can terminate muxing
    // before AAC drains (even omit audio entirely for a one-frame export).
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0',
    '-vf', input === 'jpeg' ? `${JPEG_TO_RGB},${filter}` : filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    // MP4's default 1000-tick movie clock rounds the AAC edit duration to milliseconds.
    // Match the PCM clock so, for example, 16000 samples stay 16000 rather than 15984.
    '-c:a', 'aac', '-b:a', '192k', '-movie_timescale', '48000', '-movflags', '+faststart', '-y', output];
}
/** 撮影の形式（サムネ・スライド）。省いた時の既定は描画先で決まる: 書き出しのジョブは書き出しの中間（captureFrameFormat）、{src} の描画先は PNG・等倍。 */
export interface CaptureShot { format?: 'png' | 'jpeg'; quality?: number; scale?: number }
export interface RenderSurface { capture(frame: number, shot?: CaptureShot): Promise<Buffer>;
  /** Decoder counters of the drawing page (export-speed measurement only). */
  decodeStats?(): Promise<unknown>;
  /** The source samples of the last captured frame (measurement only: RenderLimits.recordSamples). */
  samples?(): unknown;
  /** Close this surface's page (export workers close their whole browser instead). */
  close?(): Promise<void> }
/** How long a renderer may take before it counts as stuck. A frame normally takes well under a
 * second, and MP4 decoding already gives up after 10 seconds without progress. */
export interface RenderLimits { readyMs?: number; frameMs?: number; captureMode?: 'reference' | 'fast'; onFrameTiming?: (timing:{frame:number;drawMs:number;captureMs:number;rafMs?:number;shotMs?:number;phases?:Record<string,number>|null})=>void;
  /** Decoded frames kept at least per source (stage 2 of the export-speed design). 0 or absent: byte budget only, sources never released. */
  retainFrames?: number;
  /** Measurement only: read which source sample each video layer used with every frame. */
  recordSamples?: boolean }
/** The product's value; the measuring tool may override it (exportTrace.ts). */
export function exportRetainFrames(trace: Pick<ExportTraceSink, 'retainFrames'> | undefined): number {
  return trace?.retainFrames ?? EXPORT_RETAIN_FRAMES;
}
/** The drawing page of an export job. retain=N is how the export, and only the export, asks for its retention. */
export function exportRenderPageUrl(origin: string, target: { projectId: string; jobId: string }, retainFrames = 0): string {
  return `${origin}/native-render.html?${new URLSearchParams({ id: target.projectId, job: target.jobId, ...(retainFrames > 0 ? { retain: String(retainFrames) } : {}) })}`;
}
/** Load the export renderer and wait until it can draw frames. */
export async function openRenderSurface(browser: Browser, origin: string, target: { projectId: string; jobId: string } | { src: string }, resolution: { width: number; height: number }, { readyMs = 30000, frameMs = 120000, captureMode = 'fast', onFrameTiming, retainFrames, recordSamples }: RenderLimits = {}): Promise<RenderSurface> {
  const page = await browser.newPage({ viewport: { ...resolution }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000);
  let pageError: Error | undefined;
  page.on('pageerror', error => { pageError = error; });
  const response = await page.goto(`${origin}/native-render.html?host=1`);
  if (response && response.status() >= 400) throw new Error(`書き出し用の描画画面を読み込めませんでした（HTTP ${response.status()}）`);
  // Match preview's iframe boundary: Chromium clips transformed translucent layers
  // differently in a top-level page, even with identical DOM and viewport sizes.
  await page.evaluate(({src,width,height}) => {
    const frame = document.createElement('iframe');
    frame.dataset.nativeExport = 'true'; frame.width = String(width); frame.height = String(height);
    frame.style.cssText = 'border:0;display:block;pointer-events:none'; frame.src = src;
    document.getElementById('stage')!.appendChild(frame);
  }, { src: 'src' in target ? target.src : exportRenderPageUrl(origin, target, retainFrames), ...resolution });
  const surface = await page.locator('iframe[data-native-export]').elementHandle(), drawing = await surface?.contentFrame();
  if (!drawing) throw new Error('書き出しの描画画面を開けませんでした');
  try { await drawing.waitForFunction(() => window.harnessNativeReady || window.harnessNativeError, undefined, { timeout: readyMs }); }
  catch (error) {
    // A script error explains a renderer that never became ready better than the wait itself.
    if (pageError) throw new Error(`書き出し用の描画画面でエラーが起きました: ${pageError.message}`, { cause: pageError });
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`書き出し用の描画画面の準備が ${readyMs / 1000} 秒以内に終わりませんでした`, { cause: error });
    throw error;
  }
  const initError = await drawing.evaluate(() => window.harnessNativeError); if (initError) throw new Error(initError);
  // Full Chrome needs an explicit inner composition surface for backdrop-filter.
  // An iframe/outer transform alone leaves blurred caption pixels different from
  // preview; this identity transform preserves layout and the filter itself.
  await drawing.evaluate(() => { document.body.style.transform = 'translateZ(0)'; });
  // The renderer already waits for fonts/images and commits the React frame.
  // Capture the same outer viewport/iframe surface, avoiding Playwright's general
  // screenshot preparation on every frame. 'fast' is the product's JPEG (captureFrameFormat).
  const captureSession=captureMode==='fast'?await page.context().newCDPSession(page):undefined;
  const fallback:CaptureShot='src' in target?{format:'png'}:captureFrameFormat(captureMode)==='jpeg'?{format:'jpeg',quality:EXPORT_JPEG_QUALITY}:{format:'png'};
  // The hidden browser window can shrink midway (seen 2026-10-08 in a long export, cause unknown).
  // The fixed-size iframe still draws correctly, but the capture is white beyond the window,
  // so put the window back (its frame adds to the page size) or stop rather than finish a cut-off video.
  const keepWindowSize=async(frame:number,size:[number,number])=>{
    if(size[0]===resolution.width&&size[1]===resolution.height)return;
    const session=captureSession??await page.context().newCDPSession(page);
    const {windowId,bounds}=await session.send('Browser.getWindowForTarget');
    if(bounds.windowState&&bounds.windowState!=='normal')await session.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
    await session.send('Browser.setWindowBounds',{windowId,bounds:{
      width:resolution.width+(bounds.width??size[0])-size[0],height:resolution.height+(bounds.height??size[1])-size[1]}});
    const restored=await page.evaluate(()=>new Promise<[number,number]>(resolve=>{
      requestAnimationFrame(()=>requestAnimationFrame(()=>resolve([innerWidth,innerHeight])));
    }));
    if(restored[0]!==resolution.width||restored[1]!==resolution.height)
      throw new Error(`${frame + 1} コマ目で書き出し用の画面の大きさが ${size[0]}×${size[1]} に変わり、元の ${resolution.width}×${resolution.height} に戻せませんでした`);
    console.warn(`[sme] ${frame + 1} コマ目で書き出し用の画面が ${size[0]}×${size[1]} に縮んだので ${resolution.width}×${resolution.height} に戻しました`);
  };
  let samples: unknown = null;
  return {
    async capture(frame, shot) {
      if (pageError) throw pageError;
      samples = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${frame + 1} コマ目の描画が ${frameMs / 1000} 秒以内に終わりませんでした`)), frameMs);
      });
      try {
        // The losing draw settles when the runner closes the browser; race() has already handled it.
        return await Promise.race([(async()=>{
          const start=performance.now();
          let phases: Record<string, number> | null = null;
          if (recordSamples) ({ samples, phases } = await drawing.evaluate(async value => { await window.harnessNativeFrame!(value); return { samples: window.harnessNativeFrameSamples?.() ?? null, phases: window.harnessNativeFrameTiming?.() ?? null }; }, frame));
          else await drawing.evaluate(async value => { await window.harnessNativeFrame!(value); }, frame);
          const drawn=performance.now();
          // Let the compositor present the iframe before reading its surface.
          // Without this, translucent animated captions can differ by 1 RGB step
          // even though React and the canvas have completed their drawing.
          await keepWindowSize(frame,captureSession?await page.evaluate(()=>new Promise<[number,number]>(resolve=>{
            requestAnimationFrame(()=>requestAnimationFrame(()=>resolve([innerWidth,innerHeight])));
          })):await page.evaluate(()=>[innerWidth,innerHeight] as [number,number]));
          const presented=performance.now();
          const chosen=shot??fallback,format=chosen.format??'png',quality=format==='jpeg'?chosen.quality??90:undefined;
          const image=captureSession?Buffer.from((await captureSession.send('Page.captureScreenshot',{
            format,...(quality===undefined?{}:{quality}),fromSurface:true,captureBeyondViewport:false,optimizeForSpeed:true,
            clip:{x:0,y:0,width:resolution.width,height:resolution.height,scale:chosen.scale??1},
          })).data,'base64'):await page.screenshot(format==='jpeg'?{type:'jpeg',quality}:{type:'png'});
          onFrameTiming?.({frame,drawMs:drawn-start,captureMs:performance.now()-drawn,rafMs:presented-drawn,shotMs:performance.now()-presented,phases});
          return image;
        })(), stalled]);
      } finally { clearTimeout(timer); }
    },
    decodeStats: () => drawing.evaluate(() => window.harnessNativeDecodeStats?.() ?? null),
    ...(recordSamples ? { samples: () => samples } : {}),
    close: () => page.close(),
  };
}
/** Bounded: a browser that does not close in time is left to Playwright's own exit handling, with a warning. */
async function closeBrowser(browser: Browser, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([browser.close().then(() => true, () => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  if (!closed) console.warn(`[sme] 書き出し用のブラウザが ${ms / 1000} 秒以内に終了しませんでした`);
}
/** Export workers (exportParallel.ts): each its own Chromium and drawing surface. Closing a worker closes its
 * browser, which also ends a draw in progress. The launch is bounded and retried (exportBrowser.ts); a stop during
 * it ends the starting browser, and a stop after it closes the browser. */
export function chromiumExportWorker({ executablePath, origin, target, resolution, limits, closeMs = 10_000, launch }: {
  executablePath: string; origin: string; target: { projectId: string; jobId: string }; resolution: { width: number; height: number };
  /** Per worker (its own timing callback, for example). */
  limits?: RenderLimits | ((worker: number) => RenderLimits); closeMs?: number;
  /** Tests: shorter launch timeouts. */
  launch?: Partial<ExportBrowserLaunch>;
}): { open(worker: number, signal: AbortSignal): Promise<ExportWorker>; versions: string[] } {
  const versions: string[] = [];
  return { versions, async open(worker, signal) {
    const browser = await launchExportBrowser({ executablePath, signal, ...launch });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeBrowser(browser, closeMs));
    const onStop = () => { void close(); };
    signal.addEventListener('abort', onStop, { once: true });
    try {
      signal.throwIfAborted();
      versions[worker] = browser.version();
      const surface = await openRenderSurface(browser, origin, target, resolution, typeof limits === 'function' ? limits(worker) : limits);
      signal.throwIfAborted();
      return { surface, close };
    } catch (error) { await close(); throw error; }
    finally { signal.removeEventListener('abort', onStop); }
  } };
}
export interface FrameEncoder {
  write(image: Buffer): Promise<void>;
  /** Settles when FFmpeg exits: resolves on a clean exit, rejects with its error otherwise. */
  readonly closed: Promise<void>;
  /** Close the frame input and wait for a clean exit. */
  finish(): Promise<void>;
  kill(): void;
  /** Terminate an unfinished encoder and wait until it has exited. */
  stop(): Promise<void>;
}
/** FFmpeg reading intermediate frames on stdin. Its exit status and stderr tail decide success. */
export function startFrameEncoder(bin: string, args: string[], signal: AbortSignal): FrameEncoder {
  const encoder = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], signal });
  let stderr = '';
  encoder.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-16000); });
  encoder.stdin!.on('error', () => undefined);
  const done = new Promise<void>((resolve, reject) => {
    encoder.once('error', reject); encoder.once('close', code => code === 0 ? resolve() : reject(new Error(`動画の符号化に失敗しました: ${stderr || code}`)));
  });
  void done.catch(() => undefined);
  return {
    closed: done,
    async write(image) {
      try { await new Promise<void>((resolve, reject) => encoder.stdin!.write(image, error => error ? reject(error) : resolve())); }
      catch (error) {
        // A closed pipe only says FFmpeg stopped reading. Its exit status and stderr say why;
        // report that when it arrives promptly, otherwise the write error itself.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); } finally { clearTimeout(timer); }
        throw error;
      }
    },
    async finish() { encoder.stdin!.end(); await done; },
    // SIGTERM alone waits while FFmpeg is blocked reading the pipe; closing its input ends that read.
    kill() { encoder.kill('SIGTERM'); encoder.stdin!.destroy(); },
    async stop() {
      encoder.kill('SIGTERM'); encoder.stdin!.destroy();
      const force = setTimeout(() => encoder.kill('SIGKILL'), 5000);
      try { await done.catch(() => undefined); } finally { clearTimeout(force); }
    },
  };
}
export async function runSequenceExport({ plan, projectDirectory, directory, origin, status, signal,settings:requestedSettings,progress }: ExportRunInput): Promise<void> {
  const ffmpeg = resolveFfmpegBin(), ffprobe = resolveFfprobeBin(), chromiumBin = resolveNativeChromiumBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message); if (!ffprobe.ok) throw new Error(ffprobe.message); if (!chromiumBin.ok) throw new Error(chromiumBin.message);
  const doc = plan.document, audioFile = join(directory, exportScratchFiles.audio), partial = join(directory, exportScratchFiles.partial);
  const {settings,outputResolution,crf,filter}=nativeExportVideoSettings(doc.resolution,requestedSettings);
  // N drawing workers and block length L (exportParallel.ts). Read before any work so a bad value fails at once.
  const parallel = exportParallelSettings(doc.resolution);
  let encoder: FrameEncoder | undefined;
  const referenceLeases:SequenceAssetLease[]=[];
  // The drawing workers are closed by renderExportFrames on the same abort.
  const abort = () => { encoder?.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    status.phase = 'preparing';progress?.(); signal.throwIfAborted();
    await assertExportFreeSpace(directory, plan);
    for (const asset of doc.assets) {
      if (asset.kind === 'component') await readSequenceComponent(projectDirectory, asset);
      else if(isSequenceReferenceFile(asset.file))referenceLeases.push(await openSequenceAsset(projectDirectory,asset,signal));
      else await verifiedSequenceAssetPath(projectDirectory, asset, signal);
    }
    status.phase = 'audio';
    const audio = await writeSequenceAudio(plan, projectDirectory, audioFile, signal, (sample, total) => { status.audioProgress = total ? sample / total : 1;progress?.(); });
    signal.throwIfAborted();
    // Measurement only (scripts/export-baseline.ts); unset in the product.
    const trace = exportTraceSink();
    const timings = new Map<number, Omit<Parameters<NonNullable<RenderLimits['onFrameTiming']>>[0], 'frame'>>();
    const captureMode = 'fast', intermediate = captureFrameFormat(captureMode);
    const workers = chromiumExportWorker({ executablePath: chromiumBin.bin, origin, target: { projectId: status.projectId, jobId: status.id }, resolution: doc.resolution,
      limits: () => {
        const limits: RenderLimits = { captureMode, retainFrames: exportRetainFrames(trace) };
        return trace ? { ...limits, recordSamples: true, onFrameTiming: ({ frame, ...value }) => { timings.set(frame, value); } } : limits;
      } });
    // The renderer produces sRGB RGB. Matrix/range conversion (of the JPEG intermediate too) and compression are
    // explicit; FFmpeg adds no layout, transitions, or creative color processing.
    encoder = startFrameEncoder(ffmpeg.bin, encoderArguments({ fps: doc.fps, audioFile, filter, crf, output: partial, input: intermediate }), signal);
    status.phase = 'rendering';
    const framesDigest = createHash('sha256'), references: Array<{ frame: number; sha256: string }> = [];
    const referenceFrames = new Set([0, Math.floor(doc.sequenceEndFrame / 2), doc.sequenceEndFrame - 1]);
    const frameEncoder = encoder;
    const rendered = await renderExportFrames({ parallel, frames: doc.sequenceEndFrame, signal, open: workers.open,
      // FFmpeg exiting before the last frame fails the export; a stop (cancel or first failure) ends FFmpeg's write.
      watch: frameEncoder.closed, stopped: () => frameEncoder.kill(), decodeStats: Boolean(trace?.rendered),
      async frame({ frame, image, worker, samples }) {
        framesDigest.update(image);
        if (referenceFrames.has(frame)) {
          await writeFile(join(directory, `frame-${frame}.${intermediate === 'jpeg' ? 'jpg' : 'png'}`), image, { flag: 'wx' });
          references.push({ frame, sha256: createHash('sha256').update(image).digest('hex') });
        }
        const written = trace ? performance.now() : 0;
        await frameEncoder.write(image);
        if (trace) {
          const timing = timings.get(frame) ?? { drawMs: 0, captureMs: 0 }; timings.delete(frame);
          trace.frame?.({ frame, image, format: intermediate, ...timing, encodeMs: performance.now() - written, worker, ...(samples === undefined ? {} : { samples }) });
        }
        status.completedFrames = frame + 1;
        progress?.();
      } });
    trace?.rendered?.({ jobId: status.id, parallel, stats: rendered,
      decode: rendered.workers.length === 1 ? rendered.workers[0]!.decode : rendered.workers.map(worker => worker.decode) });
    status.phase = 'finalizing'; await encoder.finish(); encoder = undefined;
    signal.throwIfAborted();
    const probe = await probeExportFile(ffprobe.bin, partial, { signal, maxBuffer: 1024 * 1024 });verifyExportProbe(doc,probe,audio.sampleCount,outputResolution);
    const handle = await open(partial, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    await writeFile(join(directory, 'verification.json'), JSON.stringify({ revision: doc.revision, contentHash: status.contentHash,
      settings,outputResolution,browser: workers.versions[0], parallel,
      intermediate: intermediate === 'jpeg' ? { format: intermediate, quality: EXPORT_JPEG_QUALITY } : { format: intermediate }, framesSha256: framesDigest.digest('hex'), references, audio, probe,
      color: { primaries: 'bt709', matrix: 'bt709', transfer: 'iec61966-2-1', range: 'limited' } }, null, 2));
    // Renderer and PCM caches may have completed their final source reads long
    // before encoding finishes. Keep the admitted reference generation through
    // the final publication check, even when no further HTTP reads are needed.
    for(const reference of referenceLeases)await reference.verify();
    signal.throwIfAborted(); await rename(partial, join(directory, 'output.mp4'));
  } finally {
    signal.removeEventListener('abort', abort);
    if (encoder) await encoder.stop();
    await Promise.allSettled(referenceLeases.map(reference=>reference.close()));
    await unlink(partial).catch(() => undefined); await unlink(audioFile).catch(() => undefined);
  }
}
