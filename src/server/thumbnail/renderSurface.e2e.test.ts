import { afterAll, beforeAll, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { decodeRgba } from '../../../scripts/native-render-capture';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { openRenderSurface } from '../sequence/exportRunner';

const chromiumBin = resolveNativeChromiumBin(), available = chromiumBin.ok && resolveFfmpegBin().ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('撮影形式の検証に Chromium と FFmpeg が必要です');
const page = '<style>html,body{margin:0;overflow:hidden}#stage{width:320px;height:180px;background:#ff0000}</style><div id="stage"></div>'
  + '<script>window.harnessNativeFrame=async()=>{};window.harnessNativeReady=true</script>';
let server: Server, browser: Browser, origin = '';
beforeAll(async () => {
  if (!available || !chromiumBin.ok) return;
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(page); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: chromiumBin.bin });
});
afterAll(async () => { await browser?.close(); server?.close(); });

it.skipIf(!available)('src を渡した描画画面を開き、等倍 PNG・縮小 PNG・JPEG を撮れる', async () => {
  const surface = await openRenderSurface(browser, origin, { src: `${origin}/custom/native-render.html?thumbnailJob=x` }, { width: 320, height: 180 });
  const png = decodeRgba(await surface.capture(0));
  expect(png.length).toBe(320 * 180 * 4);
  expect([...png.subarray(0, 3)]).toEqual([255, 0, 0]);
  expect(decodeRgba(await surface.capture(0, { format: 'png', scale: .5 })).length).toBe(160 * 90 * 4);
  const jpeg = await surface.capture(0, { format: 'jpeg', quality: 80 });
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
});
