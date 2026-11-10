import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { decodePngRgba } from '../pngRgba';
import { launchExportBrowser } from './exportBrowser';
import { openRenderSurface } from './exportRunner';

const chromiumBin = resolveNativeChromiumBin(), available = chromiumBin.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('先頭コマの撮影の検証に通常Chromeが必要です');
// Chrome 157 (2026-11-10): the first clipped Page.captureScreenshot dropped Playwright's viewport override, the page fell
// back to the window's inner 1920×993 and that capture was white below row 993. A window cannot be narrower than 500 px,
// so 320×180 also checks that the page size does not depend on the window. A single colour per frame makes any row
// outside the drawn page visible.
const host = '<style>html,body{margin:0;overflow:hidden;background:#fff}</style><div id="stage"></div>';
const drawing = (w: number, h: number) => `<style>html,body{margin:0;overflow:hidden;background:#fff}#stage{width:${w}px;height:${h}px;background:rgb(200,0,120)}</style><div id="stage"></div><script>window.harnessNativeFrame=async n=>{document.getElementById('stage').style.background='rgb(200,'+(n*10)+',120)';};window.harnessNativeReady=true</script>`;
let server: Server, origin = '';
beforeAll(async () => {
  if (!available) return;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.writeHead(200, { 'content-type': 'text/html' }).end(url.pathname === '/native-render.html' ? host : drawing(Number(url.searchParams.get('w')), Number(url.searchParams.get('h'))));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Every sampled pixel (each 97th column and the last one, every row) against the frame's colour. */
function check(image: Buffer, frame: number) {
  const png = decodePngRgba(image);
  let wrong = 0, firstWrongRow = -1;
  for (let y = 0; y < png.height; y++) for (const x of [...Array.from({ length: Math.ceil(png.width / 97) }, (_, i) => i * 97), png.width - 1]) {
    const i = (y * png.width + x) * 4;
    if (png.data[i] !== 200 || png.data[i + 1] !== frame * 10 || png.data[i + 2] !== 120) { wrong++; if (firstWrongRow < 0) firstWrongRow = y; }
  }
  return { size: [png.width, png.height], wrong, firstWrongRow };
}

it.skipIf(!available).each([[1920, 1080], [320, 180]])('Chrome draws the whole first frames of a freshly opened %i×%i surface, at full and half scale, without resizing midway', async (W, H) => {
  const warn = vi.spyOn(console, 'warn');
  for (let launch = 0; launch < 3; launch++) {
    const browser = await launchExportBrowser({ executablePath: chromiumBin.ok ? chromiumBin.bin : '', signal: new AbortController().signal });
    try {
      const surface = await openRenderSurface(browser, origin, { src: `${origin}/draw?w=${W}&h=${H}` }, { width: W, height: H }, { captureMode: 'fast' });
      const clean = { size: [W, H], wrong: 0, firstWrongRow: -1 };
      expect({ launch, frame: 0, ...check(await surface.capture(0, { format: 'png' }), 0) }).toEqual({ launch, frame: 0, ...clean });
      expect({ launch, frame: 1, ...check(await surface.capture(1, { format: 'png' }), 1) }).toEqual({ launch, frame: 1, ...clean });
      expect({ launch, frame: 0, ...check(await surface.capture(0, { format: 'png', scale: 0.5 }), 0) }).toEqual({ launch, frame: 0, ...clean, size: [W / 2, H / 2] });
    } finally { await browser.close(); }
  }
  expect(warn.mock.calls.filter(args => String(args[0]).includes('縮んだので'))).toEqual([]);
}, 120_000);

// The measuring PNG capture ('reference') takes Playwright's page.screenshot, which also sends a clipped Page.captureScreenshot,
// but on Playwright's own session, the one holding the viewport override. Measured 2026-11-10 (Chrome 157.0.8103.38, 1920×1080):
// two page.screenshot calls on a freshly opened surface were whole and the page stayed 1920×1080, while the same clipped capture
// on a new CDP session (the fast capture's) was white from row 993 and left the page 1920×993, with or without optimizeForSpeed.
it.skipIf(!available).each([[1920, 1080], [320, 180]])('the reference capture also draws the whole first frames of a freshly opened %i×%i surface, without resizing midway', async (W, H) => {
  const warn = vi.spyOn(console, 'warn');
  for (let launch = 0; launch < 3; launch++) {
    const browser = await launchExportBrowser({ executablePath: chromiumBin.ok ? chromiumBin.bin : '', signal: new AbortController().signal });
    try {
      const surface = await openRenderSurface(browser, origin, { src: `${origin}/draw?w=${W}&h=${H}` }, { width: W, height: H }, { captureMode: 'reference' });
      const clean = { size: [W, H], wrong: 0, firstWrongRow: -1 };
      expect({ launch, frame: 0, ...check(await surface.capture(0), 0) }).toEqual({ launch, frame: 0, ...clean });
      expect({ launch, frame: 1, ...check(await surface.capture(1), 1) }).toEqual({ launch, frame: 1, ...clean });
    } finally { await browser.close(); }
  }
  expect(warn.mock.calls.filter(args => String(args[0]).includes('縮んだので'))).toEqual([]);
}, 120_000);
