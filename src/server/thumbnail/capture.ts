import { chromium, type Browser } from 'playwright-core';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { openRenderSurface, type CaptureShot } from '../sequence/exportRunner';

export interface ThumbnailCaptureTarget { origin: string; projectId: string; jobId: string; resolution: { width: number; height: number }; signal: AbortSignal }
export type ThumbnailCapture = (target: ThumbnailCaptureTarget, shots: readonly CaptureShot[], accept: (bytes: Buffer, shot: CaptureShot) => boolean)
  => Promise<{ bytes: Buffer; shot: CaptureShot }>;

/** 書き出しと同じ描画面で、shots を順に撮る。accept が真になった最初の結果、無ければ最後の結果を返す。 */
export const captureThumbnail: ThumbnailCapture = async (target, shots, accept) => {
  if (!shots.length) throw new Error('撮影の指定がありません');
  const bin = resolveNativeChromiumBin();
  if (!bin.ok) throw new Error(bin.message);
  target.signal.throwIfAborted();
  let browser: Browser | undefined;
  const abort = () => { void browser?.close().catch(() => undefined); };
  target.signal.addEventListener('abort', abort, { once: true });
  try {
    browser = await chromium.launch({ executablePath: bin.bin });
    target.signal.throwIfAborted();
    const surface = await openRenderSurface(browser, target.origin,
      { src: `${target.origin}/native-render.html?${new URLSearchParams({ id: target.projectId, thumbnailJob: target.jobId })}` }, target.resolution);
    let last: { bytes: Buffer; shot: CaptureShot } | undefined;
    for (const shot of shots) {
      target.signal.throwIfAborted();
      last = { bytes: await surface.capture(0, shot), shot };
      if (accept(last.bytes, shot)) return last;
    }
    return last!;
  } finally {
    target.signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
  }
};

export type ThumbnailFramesCapture = (target: ThumbnailCaptureTarget, frameCount: number, shot: CaptureShot) => Promise<Buffer[]>;
/** 書き出しと同じ描画面を 1 つ開き、0..frameCount-1 のコマを順に撮る（Chromium の起動は 1 回）。 */
export const captureThumbnailFrames: ThumbnailFramesCapture = async (target, frameCount, shot) => {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new Error('撮るコマの数が不正です');
  const bin = resolveNativeChromiumBin();
  if (!bin.ok) throw new Error(bin.message);
  target.signal.throwIfAborted();
  let browser: Browser | undefined;
  const abort = () => { void browser?.close().catch(() => undefined); };
  target.signal.addEventListener('abort', abort, { once: true });
  try {
    browser = await chromium.launch({ executablePath: bin.bin });
    target.signal.throwIfAborted();
    const surface = await openRenderSurface(browser, target.origin,
      { src: `${target.origin}/native-render.html?${new URLSearchParams({ id: target.projectId, thumbnailJob: target.jobId })}` }, target.resolution);
    const images: Buffer[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) { target.signal.throwIfAborted(); images.push(await surface.capture(frame, shot)); }
    return images;
  } finally {
    target.signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
  }
};
