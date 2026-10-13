import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { EXPORT_JPEG_QUALITY, openRenderSurface } from './exportRunner';
import { intermediateDifference, intermediateMismatch } from './intermediateCompare';
import {execFileSync} from 'node:child_process';
import {resolveFfmpegBin} from '../resolveFfmpeg';

const chromiumBin = resolveNativeChromiumBin();
if (!chromiumBin.ok && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('描画画面の失敗検証にChromiumが必要です');
// Each case stands in for native-render.html in one failure mode.
const pages: Record<string, { status: number; html: string }> = {
  '/missing': { status: 404, html: 'not found' },
  '/never-ready': { status: 200, html: '<div id="stage"></div>' },
  '/crashes': { status: 200, html: '<div id="stage"></div><script>setTimeout(()=>{throw new Error("renderer exploded")},0)</script>' },
  '/stalls': { status: 200, html: '<div id="stage"></div><script>window.harnessNativeFrame=()=>new Promise(()=>{});window.harnessNativeReady=true</script>' },
  '/paints': {status:200,html:`<style>html,body{margin:0;overflow:hidden}#stage{width:640px;height:360px;background:linear-gradient(35deg,#027b96,#f87329)}canvas{position:absolute}#text{position:absolute;left:40px;top:90px;font:32px sans-serif;color:white;padding:16px;background:#1239;backdrop-filter:blur(7px);border-radius:12px;text-shadow:2px 3px 4px #000;transform:rotate(-3deg)}</style><div id="stage"><canvas width="640" height="360"></canvas><div id="text"></div></div><script>window.harnessNativeFrame=async n=>{const ctx=document.querySelector('canvas').getContext('2d');ctx.clearRect(0,0,640,360);ctx.fillStyle='hsl('+(n*67)+',80%,45%)';ctx.fillRect(n*13,20,280,270);document.querySelector('#text').textContent='字幕 Frame '+n;await document.fonts.ready;};window.harnessNativeReady=true</script>`},
};
let server: Server, browser: Browser;
beforeAll(async () => {
  if (!chromiumBin.ok) return;
  // The first path segment selects the case: `${origin}/native-render.html` becomes `/<case>/native-render.html`.
  server = createServer((req, res) => {
    const page = pages[`/${new URL(req.url ?? '/', 'http://127.0.0.1').pathname.split('/')[1]}`];
    res.writeHead(page?.status ?? 404, { 'content-type': 'text/html' }).end(page?.html ?? 'not found');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ executablePath: chromiumBin.bin });
});
afterAll(async () => { await browser?.close(); server?.close(); });
const open = (name: string) => openRenderSurface(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/${name}`,
  { projectId: 'case', jobId: 'job' }, { width: 32, height: 32 }, { readyMs: 500, frameMs: 300 });

it.skipIf(!chromiumBin.ok)('names the HTTP status when the render page cannot be loaded', async () => {
  await expect(open('missing')).rejects.toThrow('書き出し用の描画画面を読み込めませんでした（HTTP 404）');
});
it.skipIf(!chromiumBin.ok)('says the renderer did not become ready instead of a Playwright timeout', async () => {
  await expect(open('never-ready')).rejects.toThrow('書き出し用の描画画面の準備が 0.5 秒以内に終わりませんでした');
});
it.skipIf(!chromiumBin.ok)('reports a renderer script error seen while waiting for readiness', async () => {
  await expect(open('crashes')).rejects.toThrow('書き出し用の描画画面でエラーが起きました: renderer exploded');
});
it.skipIf(!chromiumBin.ok)('gives up on a frame the renderer never finishes and names the frame', async () => {
  const surface = await open('stalls');
  await expect(surface.capture(4)).rejects.toThrow('5 コマ目の描画が 0.3 秒以内に終わりませんでした');
});

// The capture is a JPEG (exportIntermediate.test.ts); Playwright's own JPEG screenshot at the same quality goes through
// Chromium's same encoder, so the same pixels decode identically and the comparison stays exact.
it.skipIf(!chromiumBin.ok)('captures the current frame with the same pixels as the reference screenshot, including translucent blur and text',async()=>{
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  const surface=await openRenderSurface(browser,`http://127.0.0.1:${(server.address() as AddressInfo).port}/paints`,
    {projectId:'case',jobId:'job'},{width:640,height:360});
  const page=browser.contexts().at(-1)!.pages()[0]!;
  const pixels=(png:Buffer)=>execFileSync(ffmpeg.bin,['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{input:png,maxBuffer:4*1024*1024});
  let previous:Buffer|undefined;
  for(const frame of [0,1,2,17,3]){
    const actual=pixels(await surface.capture(frame));
    const expected=pixels(await page.screenshot({type:'jpeg',quality:EXPORT_JPEG_QUALITY}));
    expect(actual.equals(expected),`pixels differ at frame ${frame}`).toBe(true);
    if(previous)expect(actual.equals(previous),`stale frame ${frame}`).toBe(false);
    previous=actual;
  }
  await page.close();
});

// The JPEG against the PNG reference capture of the same frame: within the tolerance the audits use for preview
// against export (intermediateCompare.ts), while a 1-pixel shift of the same picture is far outside it.
it.skipIf(!chromiumBin.ok)('the JPEG capture keeps the PNG capture\'s luma and block colours; a shifted picture does not',async()=>{
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}/paints`;
  const reference=await openRenderSurface(browser,origin,{projectId:'case',jobId:'png'},{width:640,height:360},{captureMode:'reference'});
  const fast=await openRenderSurface(browser,origin,{projectId:'case',jobId:'jpeg'},{width:640,height:360});
  const rgba=(png:Buffer)=>execFileSync(ffmpeg.bin,['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{input:png,maxBuffer:4*1024*1024});
  for(const frame of [0,3,17]){
    const png=rgba(await reference.capture(frame)),jpeg=await fast.capture(frame);
    const difference=intermediateDifference(ffmpeg.bin,png,640,360,jpeg);
    expect(intermediateMismatch(difference),`frame ${frame}`).toBeUndefined();
    // Presence: the JPEG holds this picture; its RGB is not equal (4:2:0), and a 1-pixel shift is caught.
    const shifted=Buffer.alloc(png.length);png.copy(shifted,4,0,png.length-4);
    expect(intermediateDifference(ffmpeg.bin,shifted.map((value,i)=>i%4===3?255:value),640,360,jpeg).lumaMax).toBeGreaterThan(30);
  }
  await reference.close?.();await fast.close?.();
});

// 2026-10-08: a long export's hidden browser window shrank midway (1676×1050). The fixed-size
// iframe kept drawing correctly, but every later capture was white beyond the window, and the
// export still completed. The window must be put back before the frame is captured.
it.skipIf(!chromiumBin.ok)('restores a shrunken browser window before capturing, so the frame is not cut off',async()=>{
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  const surface=await openRenderSurface(browser,`http://127.0.0.1:${(server.address() as AddressInfo).port}/paints`,
    {projectId:'case',jobId:'job'},{width:640,height:360});
  const page=browser.contexts().at(-1)!.pages()[0]!;
  const pixels=(png:Buffer)=>execFileSync(ffmpeg.bin,['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{input:png,maxBuffer:4*1024*1024});
  const expected=pixels(await surface.capture(2));
  const cdp=await page.context().newCDPSession(page);
  const {windowId}=await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds',{windowId,bounds:{width:500,height:300}});
  expect(await page.evaluate(()=>[innerWidth,innerHeight])).not.toEqual([640,360]);
  const actual=pixels(await surface.capture(2));
  expect(actual.equals(expected),'the frame after the window shrank differs').toBe(true);
  expect(await page.evaluate(()=>[innerWidth,innerHeight])).toEqual([640,360]);
  await page.close();
});
