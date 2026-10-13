import { chromium, type Browser } from 'playwright-core';
import { SLIDES_CANVAS } from '../../core/slides/model';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { openRenderSurface, type CaptureShot } from '../sequence/exportRunner';

export interface SlidesCaptureTarget { origin: string; projectId: string; jobId: string; signal: AbortSignal }
/** 1 つのブラウザ・1 つの描画面で、ページ 0..count-1 を順に撮る（コマ番号＝ページ番号）。 */
export type SlidesCapture = (target: SlidesCaptureTarget, count: number, shot: CaptureShot, onPage: (index: number, bytes: Buffer) => void | Promise<void>) => Promise<void>;
export const captureSlides: SlidesCapture = async (target, count, shot, onPage) => {
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
      { src: `${target.origin}/native-render.html?${new URLSearchParams({ id: target.projectId, slidesJob: target.jobId })}` }, { ...SLIDES_CANVAS });
    for (let index = 0; index < count; index++) {
      target.signal.throwIfAborted();
      await onPage(index, await surface.capture(index, shot));
    }
  } finally {
    target.signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
  }
};
