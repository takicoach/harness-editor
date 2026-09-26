import { spawn } from 'node:child_process';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright-core';
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

export interface ExportRunInput {
  plan: ScenePlan; projectDirectory: string; directory: string; origin: string; status: NativeExportStatus; signal: AbortSignal;settings?:NativeExportSettings;progress?():void;
}
export function nativeExportVideoSettings(source:{width:number;height:number},value?:NativeExportSettings){
  const settings=nativeExportSettings(value),outputResolution=targetResolution(source.width,source.height,settings.resolution);
  const resize=outputResolution.width!==source.width||outputResolution.height!==source.height?`${outputResolution.width}:${outputResolution.height}:flags=lanczos:`:'';
  return {settings,outputResolution,crf:renderQualityCrf(settings.quality),filter:`scale=${resize}out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709`};
}
/** FFmpeg arguments for PNG frames on stdin plus the prepared PCM file. */
export function encoderArguments({ fps, audioFile, filter, crf, output }: { fps: { num: number; den: number }; audioFile: string; filter: string; crf: number; output: string }): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', `${fps.num}/${fps.den}`, '-i', 'pipe:0',
    // Both inputs are finite. A -frames:v output cap can terminate muxing
    // before AAC drains (even omit audio entirely for a one-frame export).
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0',
    '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    // MP4's default 1000-tick movie clock rounds the AAC edit duration to milliseconds.
    // Match the PCM clock so, for example, 16000 samples stay 16000 rather than 15984.
    '-c:a', 'aac', '-b:a', '192k', '-movie_timescale', '48000', '-movflags', '+faststart', '-y', output];
}
export interface RenderSurface { capture(frame: number): Promise<Buffer> }
/** How long a renderer may take before it counts as stuck. A frame normally takes well under a
 * second, and MP4 decoding already gives up after 10 seconds without progress. */
export interface RenderLimits { readyMs?: number; frameMs?: number; captureMode?: 'reference' | 'fast'; onFrameTiming?: (timing:{drawMs:number;captureMs:number})=>void }
/** Load the export renderer and wait until it can draw frames. */
export async function openRenderSurface(browser: Browser, origin: string, target: { projectId: string; jobId: string }, resolution: { width: number; height: number }, { readyMs = 30000, frameMs = 120000, captureMode = 'fast', onFrameTiming }: RenderLimits = {}): Promise<RenderSurface> {
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
  }, { src: `${origin}/native-render.html?${new URLSearchParams({ id: target.projectId, job: target.jobId })}`, ...resolution });
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
  // screenshot preparation on every frame. Fast PNG changes compression, not pixels.
  const captureSession=captureMode==='fast'?await page.context().newCDPSession(page):undefined;
  return {
    async capture(frame) {
      if (pageError) throw pageError;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${frame + 1} コマ目の描画が ${frameMs / 1000} 秒以内に終わりませんでした`)), frameMs);
      });
      try {
        // The losing draw settles when the runner closes the browser; race() has already handled it.
        return await Promise.race([(async()=>{
          const start=performance.now();
          await drawing.evaluate(async value => { await window.harnessNativeFrame!(value); }, frame);
          const drawn=performance.now();
          // Let the compositor present the iframe before reading its surface.
          // Without this, translucent animated captions can differ by 1 RGB step
          // even though React and the canvas have completed their drawing.
          if(captureSession)await page.evaluate(()=>new Promise<void>(resolve=>{
            requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()));
          }));
          const png=captureSession?Buffer.from((await captureSession.send('Page.captureScreenshot',{
            format:'png',fromSurface:true,captureBeyondViewport:false,optimizeForSpeed:true,
            clip:{x:0,y:0,width:resolution.width,height:resolution.height,scale:1},
          })).data,'base64'):await page.screenshot({type:'png'});
          onFrameTiming?.({drawMs:drawn-start,captureMs:performance.now()-drawn});
          return png;
        })(), stalled]);
      } finally { clearTimeout(timer); }
    },
  };
}
export interface FrameEncoder {
  write(png: Buffer): Promise<void>;
  /** Close the frame input and wait for a clean exit. */
  finish(): Promise<void>;
  kill(): void;
  /** Terminate an unfinished encoder and wait until it has exited. */
  stop(): Promise<void>;
}
/** FFmpeg reading PNG frames on stdin. Its exit status and stderr tail decide success. */
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
    async write(png) {
      try { await new Promise<void>((resolve, reject) => encoder.stdin!.write(png, error => error ? reject(error) : resolve())); }
      catch (error) {
        // A closed pipe only says FFmpeg stopped reading. Its exit status and stderr say why;
        // report that when it arrives promptly, otherwise the write error itself.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); } finally { clearTimeout(timer); }
        throw error;
      }
    },
    async finish() { encoder.stdin!.end(); await done; },
    kill() { encoder.kill('SIGTERM'); },
    async stop() {
      encoder.kill('SIGTERM');
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
  let browser: Browser | undefined, encoder: FrameEncoder | undefined;
  const referenceLeases:SequenceAssetLease[]=[];
  const abort = () => { void browser?.close().catch(() => undefined); encoder?.kill(); };
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
    browser = await chromium.launch({ executablePath: chromiumBin.bin });
    signal.throwIfAborted();
    const surface = await openRenderSurface(browser, origin, { projectId: status.projectId, jobId: status.id }, doc.resolution);
    // The renderer produces sRGB RGB. Matrix/range conversion and compression are
    // explicit; FFmpeg adds no layout, transitions, or creative color processing.
    encoder = startFrameEncoder(ffmpeg.bin, encoderArguments({ fps: doc.fps, audioFile, filter, crf, output: partial }), signal);
    status.phase = 'rendering';
    const framesDigest = createHash('sha256'), references: Array<{ frame: number; sha256: string }> = [];
    const referenceFrames = new Set([0, Math.floor(doc.sequenceEndFrame / 2), doc.sequenceEndFrame - 1]);
    for (let frame = 0; frame < doc.sequenceEndFrame; frame++) {
      signal.throwIfAborted();
      const png = await surface.capture(frame);
      framesDigest.update(png);
      if (referenceFrames.has(frame)) {
        await writeFile(join(directory, `frame-${frame}.png`), png, { flag: 'wx' });
        references.push({ frame, sha256: createHash('sha256').update(png).digest('hex') });
      }
      await encoder.write(png);
      status.completedFrames = frame + 1;
      progress?.();
    }
    status.phase = 'finalizing'; await encoder.finish(); encoder = undefined;
    signal.throwIfAborted();
    const probe = await probeExportFile(ffprobe.bin, partial, { signal, maxBuffer: 1024 * 1024 });verifyExportProbe(doc,probe,audio.sampleCount,outputResolution);
    const handle = await open(partial, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    await writeFile(join(directory, 'verification.json'), JSON.stringify({ revision: doc.revision, contentHash: status.contentHash,
      settings,outputResolution,browser: browser.version(), framesSha256: framesDigest.digest('hex'), references, audio, probe,
      color: { primaries: 'bt709', matrix: 'bt709', transfer: 'iec61966-2-1', range: 'limited' } }, null, 2));
    // Renderer and PCM caches may have completed their final source reads long
    // before encoding finishes. Keep the admitted reference generation through
    // the final publication check, even when no further HTTP reads are needed.
    for(const reference of referenceLeases)await reference.verify();
    signal.throwIfAborted(); await rename(partial, join(directory, 'output.mp4'));
  } finally {
    signal.removeEventListener('abort', abort);
    if (encoder) await encoder.stop();
    await browser?.close().catch(() => undefined);
    await Promise.allSettled(referenceLeases.map(reference=>reference.close()));
    await unlink(partial).catch(() => undefined); await unlink(audioFile).catch(() => undefined);
  }
}
