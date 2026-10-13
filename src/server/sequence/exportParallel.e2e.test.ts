import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { chromiumExportWorker, startFrameEncoder } from './exportRunner';
import { isExportFailure, renderExportFrames, type ExportParallel } from './exportParallel';

const chromiumBin = resolveNativeChromiumBin(), ffmpeg = resolveFfmpegBin(), available = chromiumBin.ok && ffmpeg.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('並列書き出しの検証に通常Chrome/FFmpegが必要です');
// Stands in for native-render.html: a canvas, a translucent blurred caption and text that change with the frame number.
const page = `<style>html,body{margin:0;overflow:hidden}#stage{width:320px;height:180px;background:linear-gradient(35deg,#027b96,#f87329)}canvas{position:absolute}#text{position:absolute;left:20px;top:50px;font:20px sans-serif;color:white;padding:8px;background:#1239;backdrop-filter:blur(7px);border-radius:8px;text-shadow:2px 3px 4px #000;transform:rotate(-3deg)}</style><div id="stage"><canvas width="320" height="180"></canvas><div id="text"></div></div><script>window.harnessNativeFrame=async n=>{const ctx=document.querySelector('canvas').getContext('2d');ctx.clearRect(0,0,320,180);ctx.fillStyle='hsl('+(n*67)+',80%,45%)';ctx.fillRect((n*13)%200,10,140,140);document.querySelector('#text').textContent='字幕 Frame '+n;await document.fonts.ready;};window.harnessNativeReady=true</script>`;
let server: Server, origin = '';
beforeAll(async () => {
  if (!available) return;
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(page); }).listen(0, '127.0.0.1');
  await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

/** Every process below this one (Chromium with its helpers, FFmpeg). */
function descendants(): Array<{ pid: number; command: string }> {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
  const found: Array<{ pid: number; command: string }> = [], parents = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (parents.has(row.ppid) && !parents.has(row.pid)) { parents.add(row.pid); found.push(row); grew = true; }
  }
  return found.filter(row => !row.command.startsWith('ps -A -o')); // this listing itself
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pids: number[], ms = 10_000): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const encoderArgs = ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0', '-f', 'null', '-'];
/** The runner's composition: Chromium workers, one FFmpeg reading the JPEG frames in order, FFmpeg killed on a stop. */
async function exportFrames(parallel: ExportParallel, frames: number, onFrame?: (frame: number) => void) {
  const controller = new AbortController(), encoder = startFrameEncoder(ffmpeg.ok ? ffmpeg.bin : '', encoderArgs, controller.signal);
  const workers = chromiumExportWorker({ executablePath: chromiumBin.ok ? chromiumBin.bin : '', origin, target: { projectId: 'case', jobId: 'job' }, resolution: { width: 320, height: 180 } });
  const images: Buffer[] = [];
  try {
    await renderExportFrames({ parallel, frames, signal: controller.signal, open: workers.open, watch: encoder.closed, stopped: () => encoder.kill(),
      frame: async item => { images.push(item.image); await encoder.write(item.image); onFrame?.(item.frame); } });
    await encoder.finish();
  } finally { await encoder.stop(); }
  return { images, versions: workers.versions };
}

it.skipIf(!available)('N=2 real browsers: the same JPEG bytes as N=1, every frame in order, and nothing left running', async () => {
  const before = new Set(descendants().map(row => row.pid));
  const one = await exportFrames({ workers: 1, blockFrames: 4 }, 24);
  const two = await exportFrames({ workers: 2, blockFrames: 4 }, 24);
  expect(two.images).toHaveLength(24); expect(two.versions.filter(Boolean)).toHaveLength(2);
  // JPEG encoding is deterministic: the same pixels give the same bytes, so equal bytes are the strict comparison.
  for (let frame = 0; frame < 24; frame++) expect(two.images[frame]!.equals(one.images[frame]!), `frame ${frame}`).toBe(true);
  // Presence: JPEGs, and the frames differ from each other (a blank or frozen surface would also be "equal").
  expect(one.images.every(image => image[0] === 0xff && image[1] === 0xd8)).toBe(true);
  expect(new Set(one.images.map(image => image.toString('base64'))).size).toBe(24);
  expect(descendants().filter(row => !before.has(row.pid))).toEqual([]);
}, 120_000);

it.skipIf(!available)('a worker browser killed mid-export fails the job with that error, and no Chromium or FFmpeg remains', async () => {
  const before = new Set(descendants().map(row => row.pid));
  let started: number[] = [], killed = 0;
  const error = await exportFrames({ workers: 2, blockFrames: 3 }, 60, frame => {
    if (frame !== 7 || killed) return;
    const mine = descendants().filter(row => !before.has(row.pid));
    started = mine.map(row => row.pid);
    // Two browser main processes (children of this process); kill the second worker's.
    const browsers = mine.filter(row => chromiumBin.ok && row.command.includes(chromiumBin.bin) && !row.command.includes('--type='));
    expect(browsers).toHaveLength(2);
    killed = browsers.sort((a, b) => a.pid - b.pid)[1]!.pid; process.kill(killed, 'SIGKILL');
  }).then(() => undefined, value => value as Error);
  expect(killed).toBeGreaterThan(0);
  expect(error).toBeInstanceOf(Error);
  expect(isExportFailure(error)).toBe(true);
  expect(error!.message).not.toMatch(/abort/i);
  expect(started.some(pid => !before.has(pid))).toBe(true);
  expect(await gone(started)).toEqual([]);
  expect(descendants().filter(row => !before.has(row.pid))).toEqual([]);
}, 120_000);
