/** The canvas engine's Node half (settings engine 'canvas'; the page half is preview/native/exportCanvasPage.ts).
 * One browser, one drawing page and one VideoEncoder for the whole export. Frames are drawn in order; every
 * CANVAS_KEY_FRAME_INTERVAL frames the bytes the encoder has output so far go to FFmpeg, and the next frame is drawn
 * only once FFmpeg has taken them, so neither side holds more than a block. FFmpeg copies the H.264 stream into the
 * MP4 with the audio (exportCanvasSupport.canvasEncoderArguments). */
import { createHash } from 'node:crypto';
import type { RenderQuality } from '../../shared/renderPreset';
import { EXPORT_RETAIN_FRAMES } from '../../preview/native/exportSourceRelease';
import type { CanvasExportConfig, HarnessCanvasExport } from '../../preview/native/exportCanvasPage';
import { CANVAS_KEY_FRAME_INTERVAL, canvasEncoderConfig } from './exportCanvasSupport';
import { launchExportBrowser, type ExportBrowserLaunch } from './exportBrowser';
import { markExportFailure } from './exportParallel';
import { closeBrowser, exportRenderPageUrl, openDrawingFrame } from './exportRunner';

export interface CanvasExportInput {
  executablePath: string; origin: string; target: { projectId: string; jobId: string };
  resolution: { width: number; height: number }; fps: { num: number; den: number }; frames: number; quality: RenderQuality; signal: AbortSignal;
  /** Hands encoded bytes to FFmpeg; resolves once they are written. */
  write(bytes: Buffer): Promise<void>;
  /** Settles when FFmpeg exits. Before the export ends, either way, that fails the export. */
  encoderClosed: Promise<void>;
  referenceFrames: ReadonlySet<number>; reference(frame: number, png: Buffer): Promise<void>;
  progress(completedFrames: number): void;
  /** Each step in the page (a frame, a hand-over, the start) at most this long. */
  frameMs?: number; readyMs?: number; closeMs?: number;
  /** Tests: shorter launch timeouts. */
  launch?: Partial<ExportBrowserLaunch>;
}
export interface CanvasExportResult {
  browser: string; encoder: { codec: string; quantizer: number; hardwareAcceleration: string; keyFrameInterval: number };
  /** sha256 of every byte written to FFmpeg, in order. */
  streamSha256: string;
}

export async function renderCanvasExport({ executablePath, origin, target, resolution, fps, frames, quality, signal, write, encoderClosed, referenceFrames, reference, progress,
  frameMs = 120_000, readyMs = 30_000, closeMs = 10_000, launch }: CanvasExportInput): Promise<CanvasExportResult> {
  // The export's own failure is marked as it is thrown, before the browser closes and FFmpeg stops, so a cancel arriving
  // during that cleanup leaves it recorded as failed with its reason (exports.ts), as exportParallel does. A stop stays a stop.
  const failed = (reason: unknown) => reason === signal.reason ? reason : markExportFailure(reason);
  const browser = await launchExportBrowser({ executablePath, signal, ...launch }).catch(error => { throw failed(error); });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= closeBrowser(browser, closeMs));
  // A stop, or FFmpeg ending early, closes the browser: the step in progress then fails, and reports this reason
  // rather than the closed page. One reason per export, so a long export adds nothing per frame.
  let halted: unknown;
  const halt = (reason: unknown) => { halted ??= reason; void close(); };
  const onStop = () => { halt(signal.reason); };
  signal.addEventListener('abort', onStop, { once: true });
  let finished = false;
  void encoderClosed.then(() => { if (!finished) halt(new Error('動画の符号化が書き出しの途中で終わりました')); }, error => { if (!finished) halt(error); });
  // A browser that ends by itself (a crash) says so in Japanese instead of Playwright's closed-target message.
  browser.on('disconnected', () => { if (!finished) halt(new Error('書き出し用のブラウザが途中で終了しました')); });
  try {
    signal.throwIfAborted();
    const version = browser.version();
    const { drawing, failure } = await openDrawingFrame(browser, origin, exportRenderPageUrl(origin, target, EXPORT_RETAIN_FRAMES, true), resolution, readyMs);
    // The page half's rejections (the encoder's error, a stall) are written for the user. Thrown out of evaluate,
    // Playwright would hand them over as "frame.evaluate: Error: …" with the page's stack and URLs, so the page
    // returns the message and it is thrown here as it is.
    const call = async <T>(method: keyof HarnessCanvasExport, value?: unknown): Promise<T> => {
      const outcome = await drawing.evaluate(async ({ method, value }) => {
        const api = window.harnessCanvasExport as unknown as Record<string, (value?: unknown) => Promise<unknown>>;
        try { return { value: await api[method]!(value) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      }, { method, value });
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return outcome.value as T;
    };
    const step = async <T>(work: () => Promise<T>, stalled: string): Promise<T> => {
      if (halted !== undefined) throw halted;
      const pageError = failure(); if (pageError) throw pageError;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The losing evaluation settles when the browser closes; race() has already handled it.
        return await Promise.race([work(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(stalled)), frameMs); })]);
      } catch (error) { throw halted ?? error; }
      finally { clearTimeout(timer); }
    };
    const digest = createHash('sha256');
    const send = async (data: string) => {
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length) return;
      digest.update(bytes);
      try { await write(bytes); } catch (error) { throw halted ?? error; }
    };
    const config: CanvasExportConfig = { ...canvasEncoderConfig(resolution, fps, quality), fps, keyFrameInterval: CANVAS_KEY_FRAME_INTERVAL };
    const seconds = frameMs / 1000;
    const started = await step(() => call<Awaited<ReturnType<HarnessCanvasExport['start']>>>('start', config), `速い書き出しの準備が ${seconds} 秒以内に終わりませんでした`);
    for (let frame = 0; frame < frames; frame++) {
      await step(() => call<void>('frame', frame), `${frame + 1} コマ目の描画が ${seconds} 秒以内に終わりませんでした`);
      if (referenceFrames.has(frame))
        await reference(frame, Buffer.from(await step(() => call<string>('png'), `${frame + 1} コマ目の確認用の画像が ${seconds} 秒以内にできませんでした`), 'base64'));
      // Key frames start each block, so a hand-over always ends just before the next key frame is drawn.
      if ((frame + 1) % CANVAS_KEY_FRAME_INTERVAL === 0)
        await send(await step(() => call<string>('take'), `${frame + 1} コマ目までの圧縮データを ${seconds} 秒以内に受け取れませんでした`));
      progress(frame + 1);
    }
    await send(await step(() => call<string>('finish'), `最後の圧縮データを ${seconds} 秒以内に受け取れませんでした`));
    if (halted !== undefined) throw halted;
    finished = true;
    return { browser: version, encoder: { codec: started.codec, quantizer: config.quantizer, hardwareAcceleration: started.hardwareAcceleration, keyFrameInterval: CANVAS_KEY_FRAME_INTERVAL },
      streamSha256: digest.digest('hex') };
  } catch (error) {
    // Also while the drawing page opens: there, a halt surfaces as Playwright's closed-page error.
    throw failed(halted ?? error);
  } finally {
    finished = true;
    signal.removeEventListener('abort', onStop);
    await close();
  }
}
