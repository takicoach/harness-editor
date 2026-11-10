/**
 * The canvas engine (HTML in Canvas + VideoEncoder). Mac (Apple silicon) with Chrome 157 only; required there under
 * HARNESS_REQUIRE_CAPTURE_E2E=1.
 *
 * Two levels, each where it is lightest:
 * - Order, timestamps, colour, the 2688×1512 level and the encoder's own failures run renderCanvasExport against
 *   stand-in drawing pages: a node http server answers native-render.html, as exportParallel.e2e does, and each page
 *   installs the real page half (exportCanvasPage.ts, compiled with esbuild). The runner's own page URL is simply served
 *   by the stand-in, so nothing is added to the product for this, no project is needed per case, and a page can
 *   replace VideoEncoder to make the encoder fail or stall.
 * - Everything a project and the job records decide goes through the product: the dev server, a small real project
 *   and POST /api/sequence/export (PSNR against the screenshot path, the refusal, a cancel, FFmpeg or Chrome ending
 *   mid-export: no process, no output.mp4 and no scratch file left).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { resolveFfmpegBin, resolveFfprobeBin } from '../resolveFfmpeg';
import { DEFAULT_TEXT_APPEARANCE, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { NativeExportStatus } from '../../shared/nativeExport';
import { SequenceStore } from './store';
import { launchExportBrowser } from './exportBrowser';
import { CANVAS_KEY_FRAME_INTERVAL, canvasEncoderArguments, canvasEncoderConfig } from './exportCanvasSupport';
import { renderCanvasExport } from './exportCanvas';
import { isExportFailure } from './exportParallel';
import { captureFrameFormat, closeBrowser, encoderArguments, exportRenderPageUrl, nativeExportVideoSettings, openDrawingFrame, openRenderSurface, startFrameEncoder } from './exportRunner';
import { probeExportFile, verifyExportProbe, verifyNoFrameReordering } from './exportVerification';
import { exportScratchFiles } from './exportRecords';
import { frameCount, psnrSeries } from '../../../scripts/export-mp4-compare';

const mac = process.platform === 'darwin' && process.arch === 'arm64';
const chrome = resolveNativeChromiumBin(), ffmpeg = resolveFfmpegBin(), ffprobe = resolveFfprobeBin();
const available = mac && chrome.ok && ffmpeg.ok && ffprobe.ok;
if (mac && !available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('速い書き出しの必須検証に Chrome 157・FFmpeg・FFprobe が必要です');
const chromeBin = chrome.ok ? chrome.bin : '', ffmpegBin = ffmpeg.ok ? ffmpeg.bin : '', ffprobeBin = ffprobe.ok ? ffprobe.bin : '';
const root = resolve(import.meta.dirname, '../../..');
type Fps = { num: number; den: number };
type Size = { width: number; height: number };

/** Every process below this one (Chromium with its helpers, FFmpeg), as in exportParallel.e2e. */
function descendants(): Array<{ pid: number; command: string }> {
  const rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
  const found: Array<{ pid: number; command: string }> = [], parents = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (parents.has(row.ppid) && !parents.has(row.pid)) { parents.add(row.pid); found.push(row); grew = true; }
  }
  return found.filter(row => !row.command.startsWith('ps -A')); // this listing itself
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pids: number[], ms = 10_000): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(done => setTimeout(done, 100));
  }
}
const isChromeMain = (row: { command: string }) => row.command.includes(chromeBin) && !row.command.includes('--type=');
/** The canvas engine's FFmpeg (exportCanvasSupport.canvasEncoderArguments): raw H.264 on stdin. */
const isCanvasFfmpeg = (row: { command: string }) => row.command.startsWith(`${ffmpegBin} `) && row.command.includes('-f h264') && row.command.includes('pipe:0');

describe.skipIf(!available)('stand-in pages: renderCanvasExport and the page half', () => {
  /** Frame n drawn as 16 squares, 8 across and 2 down, square i white when bit i of n is set. */
  const BIT_COLUMNS = 8, BITS = 16;
  /** exportColor.e2e.test.ts's patches, plus the complements, a grey ramp and the near-black and near-white steps. */
  const CHART: Array<[string, [number, number, number]]> = [
    ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['cyan', [0, 255, 255]], ['magenta', [255, 0, 255]],
    ['yellow', [255, 255, 0]], ['skin', [233, 180, 150]], ['amber', [255, 200, 0]], ['sky', [0, 200, 255]], ['purple', [180, 0, 200]],
    ['black', [0, 0, 0]], ['grey8', [8, 8, 8]], ['grey16', [16, 16, 16]], ['grey32', [32, 32, 32]], ['grey64', [64, 64, 64]],
    ['grey', [128, 128, 128]], ['grey192', [192, 192, 192]], ['grey235', [235, 235, 235]], ['grey247', [247, 247, 247]], ['white', [255, 255, 255]],
  ];
  const CHART_SIZE = { width: 640, height: 360 }, CHART_COLUMNS = 5, PATCH_W = CHART_SIZE.width / CHART_COLUMNS, PATCH_H = CHART_SIZE.height / 4, CHART_FRAMES = 3;
  /** A page variant's export encoder (the second VideoEncoder made: start() makes a trial one first) after JAM_AT frames:
   * 'error' reports full and then an encoder error while frame() waits for a place, 'stall' reports full forever,
   * 'flush' never finishes its flush. The rest of the encoder is the browser's own. */
  const JAM_AT = 5;
  const sabotage = (mode: string, jamAt: number) => {
    const Real = VideoEncoder;
    let made = 0;
    window.VideoEncoder = class extends Real {
      #report: (error: DOMException) => void; #encoded = 0; #jammed = false; #export = made++ === 1;
      constructor(init: VideoEncoderInit) { super(init); this.#report = init.error; }
      override get encodeQueueSize() { return this.#jammed ? 99 : super.encodeQueueSize; }
      override encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
        super.encode(frame, options);
        if (!this.#export || mode === 'flush' || ++this.#encoded !== jamAt) return;
        this.#jammed = true;
        if (mode === 'error') setTimeout(() => { this.#report(new DOMException('試験で起こした圧縮器の失敗', 'EncodingError')); }, 300);
      }
      override flush() { return this.#export && mode === 'flush' ? new Promise<void>(() => undefined) : super.flush(); }
    };
  };
  const HOST_PAGE = '<!doctype html><style>html,body{margin:0;overflow:hidden;background:#fff}</style><div id="stage"></div>';
  function drawingPage(id: string, canvas: boolean): string {
    // A page that loads but never says it is ready: the runner is still opening it.
    if (id === 'never-ready') return '<!doctype html><p>never ready</p>';
    const bits = /^bits-(\d+)x(\d+)(?:-(error|stall|flush))?$/.exec(id);
    const stage = bits
      ? `<div id="stage" style="width:${bits[1]}px;height:${bits[2]}px;display:grid;grid-template-columns:repeat(${BIT_COLUMNS},1fr);grid-template-rows:repeat(${BITS / BIT_COLUMNS},1fr)">${'<div></div>'.repeat(BITS)}</div>`
      : `<div id="stage" style="width:${CHART_SIZE.width}px;height:${CHART_SIZE.height}px;display:grid;grid-template-columns:repeat(${CHART_COLUMNS},${PATCH_W}px);grid-auto-rows:${PATCH_H}px">${CHART.map(([, [red, green, blue]]) => `<div style="background:rgb(${red},${green},${blue})"></div>`).join('')}</div>`;
    const draw = bits ? `window.harnessNativeFrame=async n=>{[...stage.children].forEach((cell,i)=>{cell.style.background=(n>>i)&1?'#fff':'#000';});};` : 'window.harnessNativeFrame=async()=>{};';
    return `<!doctype html><style>html,body{margin:0;overflow:hidden}</style>${stage}<script type="module">import{installCanvasExport}from'/exportCanvasPage.js';`
      + `const stage=document.getElementById('stage');${draw}${bits?.[3] ? `(${sabotage.toString()})(${JSON.stringify(bits[3])},${JAM_AT});` : ''}${canvas ? 'installCanvasExport(stage);' : ''}window.harnessNativeReady=true;</script>`;
  }
  let server: Server, origin = '', work = '';
  /** Called once when the drawing page of that id is requested. */
  const requested = new Map<string, () => void>();
  beforeAll(async () => {
    const { transformWithEsbuild } = await import('vite');
    const pageModule = (await transformWithEsbuild(await readFile(join(root, 'src/preview/native/exportCanvasPage.ts'), 'utf8'), 'exportCanvasPage.ts', { format: 'esm' })).code;
    server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      if (url.pathname === '/exportCanvasPage.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(pageModule); return; }
      if (url.pathname !== '/native-render.html') { res.writeHead(404).end(); return; }
      const id = url.searchParams.get('id') ?? '';
      if (!url.searchParams.has('host')) { requested.get(id)?.(); requested.delete(id); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(url.searchParams.has('host') ? HOST_PAGE : drawingPage(url.searchParams.get('id') ?? '', url.searchParams.get('canvas') === '1'));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    work = await mkdtemp(join(tmpdir(), 'harness-export-canvas-stand-in-'));
  });
  afterAll(async () => { server?.close(); if (work) await rm(work, { recursive: true, force: true }); });

  /** The runner's composition (exportRunner.runSequenceExport, canvas branch) on a stand-in page: silent PCM of the
   * export's length, FFmpeg with the product's arguments, renderCanvasExport writing to it. */
  async function exportCanvas(id: string, resolution: Size, fps: Fps, frames: number) {
    const name = `${id}-${fps.num}-${fps.den}-${frames}-${randomUUID().slice(0, 8)}`, audioFile = join(work, `${name}.f32le`), output = join(work, `${name}.mp4`);
    const sampleCount = Math.round(frames * 48000 * fps.den / fps.num);
    await writeFile(audioFile, Buffer.alloc(sampleCount * 2 * 4));
    const controller = new AbortController(), encoder = startFrameEncoder(ffmpegBin, canvasEncoderArguments({ fps, audioFile, output }), controller.signal);
    try {
      const result = await renderCanvasExport({ executablePath: chromeBin, origin, target: { projectId: id, jobId: name }, resolution, fps, frames, quality: 'high', signal: controller.signal,
        write: bytes => encoder.write(bytes), encoderClosed: encoder.closed, referenceFrames: new Set(), reference: async () => undefined, progress: () => undefined });
      await encoder.finish();
      return { output, sampleCount, result };
    } finally { await encoder.stop(); }
  }
  /** Every decoded frame's number, read from its squares (each scaled to one grey pixel), in decoder output order. */
  function readBits(file: string): number[] {
    const grey = execFileSync(ffmpegBin, ['-v', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', `scale=${BIT_COLUMNS}:${BITS / BIT_COLUMNS}:flags=area,format=gray`,
      '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    expect(grey.length % BITS).toBe(0);
    const numbers: number[] = [];
    for (let offset = 0; offset < grey.length; offset += BITS) {
      let value = 0;
      for (let bit = 0; bit < BITS; bit++) {
        const level = grey[offset + bit]!;
        // Squares are black or white; anything near the middle is a broken frame, not a bit.
        expect(level < 64 || level > 192, `frame ${numbers.length} square ${bit}: grey ${level}`).toBe(true);
        if (level > 128) value |= 1 << bit;
      }
      numbers.push(value);
    }
    return numbers;
  }
  /** The video track's packets and duration in its own time base. */
  function videoTrack(file: string) {
    const probe = JSON.parse(execFileSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base,duration_ts,level,profile:packet=pts,dts', '-of', 'json', file], { encoding: 'utf8' }));
    const stream = probe.streams[0] as { time_base: string; duration_ts: number; level: number; profile: string };
    const [num, den] = stream.time_base.split('/').map(Number) as [number, number];
    return { timeBase: { num, den }, durationTs: stream.duration_ts, level: stream.level, profile: stream.profile, packets: (probe.packets as Array<{ pts: number; dts: number }>) };
  }
  /** The product's completed-file checks (frame count, size, rate, colour tags, audio length = PCM samples, no
   * reordering), then each frame's PTS at n × den/num and the track's length at frames × den/num, within 1 tick. */
  async function verifyTiming(output: string, resolution: Size, fps: Fps, frames: number, sampleCount: number) {
    const probe = await probeExportFile(ffprobeBin, output, { maxBuffer: 1024 * 1024 });
    verifyExportProbe({ sequenceEndFrame: frames, resolution, fps } as SequenceDocument, probe, sampleCount);
    verifyNoFrameReordering(probe);
    const track = videoTrack(output), ticks = (frame: number) => frame * fps.den * track.timeBase.den / (fps.num * track.timeBase.num);
    expect(track.packets).toHaveLength(frames);
    track.packets.forEach((packet, frame) => {
      expect(Math.abs(packet.pts - ticks(frame)), `frame ${frame}: pts ${packet.pts}, expected ${ticks(frame)} (time base ${track.timeBase.num}/${track.timeBase.den})`).toBeLessThanOrEqual(1);
      expect(packet.dts).toBe(packet.pts);
      if (frame > 0) expect(packet.pts).toBeGreaterThan(track.packets[frame - 1]!.pts);
    });
    expect(Math.abs(track.durationTs - ticks(frames)), `duration ${track.durationTs}, expected ${ticks(frames)}`).toBeLessThanOrEqual(1);
    return track;
  }
  const range = (count: number) => Array.from({ length: count }, (_, frame) => frame);

  it('150 frames come out once each, in order: frame numbers drawn as squares, read back from every decoded frame', async () => {
    const { output, result } = await exportCanvas('bits-320x180', { width: 320, height: 180 }, { num: 30, den: 1 }, 150);
    expect(readBits(output)).toEqual(range(150));
    expect(result.encoder).toMatchObject({ quantizer: 22, keyFrameInterval: CANVAS_KEY_FRAME_INTERVAL });
    expect(result.streamSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  // Every rate × every length that matters for the hand-overs: 1 (only finish), 59 (one short of the first hand-over),
  // 60 (a hand-over, then an empty-or-tail finish) and 61 (a hand-over and one more frame). 28 short exports.
  const rates: Fps[] = [{ num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30, den: 1 }, { num: 60, den: 1 }, { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 60000, den: 1001 }];
  it.each(rates.flatMap(fps => [1, 59, 60, 61].map(frames => [`${fps.num}/${fps.den}`, frames, fps] as const)))('timestamps at %s fps × %i frames: PTS n × den/num, track length, audio length, no reordering', async (_label, frames, fps) => {
    const resolution = { width: 320, height: 180 }, { output, sampleCount } = await exportCanvas('bits-320x180', resolution, fps, frames);
    await verifyTiming(output, resolution, fps, frames, sampleCount);
    expect(readBits(output)).toEqual(range(frames));
  }, 30_000);

  it('2688×1512 at 60000/1001: 61 frames at H.264 level 5.1 (avc1.640033), in order and on time', async () => {
    const resolution = { width: 2688, height: 1512 }, fps = { num: 60000, den: 1001 };
    const { output, sampleCount, result } = await exportCanvas('bits-2688x1512', resolution, fps, 61);
    expect(result.encoder.codec).toBe('avc1.640033');
    const track = await verifyTiming(output, resolution, fps, 61, sampleCount);
    expect(track).toMatchObject({ level: 51, profile: 'High' });
    expect(readBits(output)).toEqual(range(61));
  }, 60_000);

  /** The delivered MP4's last frame as RGB (as tagged: BT.709 limited range), averaged over the inner half of each patch. */
  function patchMeans(file: string, matrix = 'bt709'): Array<[number, number, number]> {
    const { width, height } = CHART_SIZE;
    const rgb = execFileSync(ffmpegBin, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${CHART_FRAMES - 1}),scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
    expect(rgb.length).toBe(width * height * 3);
    return CHART.map((_, index) => {
      const left = (index % CHART_COLUMNS) * PATCH_W + PATCH_W / 4, top = Math.floor(index / CHART_COLUMNS) * PATCH_H + Math.floor(PATCH_H / 4), sum = [0, 0, 0];
      for (let y = top; y < top + PATCH_H / 2; y++) for (let x = left; x < left + PATCH_W / 2; x++) for (let c = 0; c < 3; c++) sum[c]! += rgb[(y * width + x) * 3 + c]!;
      return sum.map(value => value / (PATCH_W / 2 * PATCH_H / 2)) as [number, number, number];
    });
  }
  const differences = (a: Array<[number, number, number]>, b: Array<[number, number, number]>) => a.flatMap((patch, i) => patch.map((value, c) => value - b[i]![c]!));
  const worst = (a: Array<[number, number, number]>, b: Array<[number, number, number]>) => Math.max(...differences(a, b).map(Math.abs));
  const round = (value: number) => Math.round(value * 100) / 100;
  const colourTags = (file: string) => JSON.parse(execFileSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_transfer,color_primaries,color_range', '-of', 'json', file], { encoding: 'utf8' })).streams[0];

  it('colours: each patch of the canvas MP4 within 3 of the screenshot path\'s MP4 per channel, no channel shifted one way, the same colour tags', async () => {
    // The screenshot path's delivered MP4 of the same page: the product's capture (JPEG) and FFmpeg arguments.
    const browser = await launchExportBrowser({ executablePath: chromeBin, signal: new AbortController().signal });
    const captured: Buffer[] = [];
    try {
      const surface = await openRenderSurface(browser, origin, { projectId: 'chart', jobId: 'capture' }, CHART_SIZE, { captureMode: 'fast' });
      for (let frame = 0; frame < CHART_FRAMES; frame++) captured.push(await surface.capture(frame));
    } finally { await closeBrowser(browser, 10_000); }
    const fps = { num: 30, den: 1 }, audioFile = join(work, 'chart-capture.f32le'), capture = join(work, 'chart-capture.mp4');
    await writeFile(audioFile, Buffer.alloc(48000 * CHART_FRAMES / 30 * 2 * 4));
    const { filter, crf } = nativeExportVideoSettings(CHART_SIZE);
    const encoder = startFrameEncoder(ffmpegBin, encoderArguments({ fps, audioFile, filter, crf, output: capture, input: captureFrameFormat('fast') }), new AbortController().signal);
    try { for (const image of captured) await encoder.write(image); await encoder.finish(); } finally { await encoder.stop(); }
    const canvas = await exportCanvas('chart', CHART_SIZE, fps, CHART_FRAMES);

    const expected = patchMeans(capture), actual = patchMeans(canvas.output), drawn = CHART.map(([, value]) => value);
    const signed = differences(actual, expected), perChannel = [0, 1, 2].map(c => signed.filter((_, i) => i % 3 === c));
    const report = { worst: round(worst(actual, expected)), meanAbs: round(signed.reduce((sum, value) => sum + Math.abs(value), 0) / signed.length),
      meanSignedRGB: perChannel.map(values => round(values.reduce((sum, value) => sum + value, 0) / values.length)),
      captureFromDrawn: round(worst(expected, drawn)), canvasFromDrawn: round(worst(actual, drawn)),
      patches: Object.fromEntries(CHART.map(([name], i) => [name, { capture: expected[i]!.map(round), canvas: actual[i]!.map(round) }])) };
    console.info('[canvas e2e colour]', JSON.stringify(report));
    // Presence: both MP4s hold the drawn chart (limited range, 4:2:0 and the compression cost a few steps).
    expect(report.captureFromDrawn).toBeLessThanOrEqual(6); expect(report.canvasFromDrawn).toBeLessThanOrEqual(6);
    // Measured 2026-11-10 (Mac mini M4, Chrome 157.0.8103.38, 3 runs, the same every run): worst 2 (purple's red),
    // mean |difference| 0.15 over the 60 values, mean signed per channel R −0.1, G +0.05, B 0. The limit is that worst
    // plus one step for another Mac's encoder rounding; a different matrix moves the saturated patches by 21 (the control below).
    expect(report.worst).toBeLessThanOrEqual(3);
    // A conversion difference moves every patch the same way; compression noise does not (measured within ±0.1).
    for (const mean of report.meanSignedRGB) expect(Math.abs(mean)).toBeLessThanOrEqual(0.5);
    expect(colourTags(canvas.output)).toEqual(colourTags(capture));
    expect(colourTags(canvas.output)).toEqual({ color_space: 'bt709', color_transfer: 'iec61966-2-1', color_primaries: 'bt709', color_range: 'tv' });
    // Control: the same canvas MP4 read as BT.601 must fail, or this comparison could not see a matrix mix-up.
    const misread = patchMeans(canvas.output, 'bt601');
    console.info('[canvas e2e colour] read as BT.601:', round(worst(misread, expected)));
    expect(worst(misread, expected)).toBeGreaterThan(10);
  }, 60_000);

  describe('the encoder failing inside the page (a page that replaces VideoEncoder)', () => {
    const size = { width: 320, height: 180 }, fps = { num: 30, den: 1 };
    const config = { ...canvasEncoderConfig(size, fps, 'high'), fps, keyFrameInterval: CANVAS_KEY_FRAME_INTERVAL };
    /** Drive the page half directly: start, then frames until one rejects (or `frames` pass and finish runs). */
    async function drive(variant: 'error' | 'stall' | 'flush', frames = 20) {
      const browser = await launchExportBrowser({ executablePath: chromeBin, signal: new AbortController().signal });
      try {
        const { drawing } = await openDrawingFrame(browser, origin, exportRenderPageUrl(origin, { projectId: `bits-320x180-${variant}`, jobId: 'page' }, 0, true), size, 30_000);
        return await drawing.evaluate(async ({ value, count }) => {
          const api = window.harnessCanvasExport!;
          const failure = async (work: () => Promise<unknown>) => { try { await work(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } };
          await api.start(value);
          for (let frame = 0; frame < count; frame++) {
            const began = performance.now(), message = await failure(() => api.frame(frame));
            if (message) return { step: `frame ${frame}`, message, ms: performance.now() - began,
              later: [await failure(() => api.frame(frame + 1)), await failure(() => api.take()), await failure(() => api.finish())] };
          }
          const began = performance.now(), message = await failure(() => api.finish());
          return { step: 'finish', message, ms: performance.now() - began, later: [] as Array<string | null> };
        }, { value: config, count: frames });
      } finally { await closeBrowser(browser, 10_000); }
    }

    it('an encoder error ends the wait for a free place at once, and every later call rejects with it', async () => {
      const outcome = await drive('error');
      const reason = '映像の圧縮に失敗しました: 試験で起こした圧縮器の失敗';
      expect(outcome).toMatchObject({ step: `frame ${JAM_AT}`, message: reason, later: [reason, reason, reason] });
      // The error arrives 300 ms into the wait; the 10 s stall limit must not be what ended it.
      expect(outcome.ms).toBeLessThan(5_000);
    }, 60_000);

    it('a queue that never frees a place, and a flush that never ends, are each given up after 10 s', async () => {
      const [stall, flush] = await Promise.all([drive('stall'), drive('flush', 10)]);
      expect(stall).toMatchObject({ step: `frame ${JAM_AT}`, message: `${JAM_AT + 1} コマ目で映像の圧縮が 10 秒以上進みません` });
      expect(flush).toMatchObject({ step: 'finish', message: '映像の圧縮の締めくくりが 10 秒以内に終わりませんでした' });
      for (const outcome of [stall, flush]) { expect(outcome.ms).toBeGreaterThanOrEqual(9_900); expect(outcome.ms).toBeLessThan(15_000); }
    }, 60_000);

    it('renderCanvasExport fails with the encoder\'s error, and its browser and FFmpeg do not remain', async () => {
      const before = new Set(descendants().map(row => row.pid));
      const error = await exportCanvas('bits-320x180-error', size, fps, 60).then(() => undefined, value => value as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe('映像の圧縮に失敗しました: 試験で起こした圧縮器の失敗');
      const left = descendants().filter(row => !before.has(row.pid));
      expect(await gone(left.map(row => row.pid))).toEqual([]);
    }, 60_000);
  });

  // A failure is marked as the export's own (isExportFailure) when it happens, before the browser closes, so a cancel
  // arriving during that cleanup does not record it as cancelled (exports.ts), as with the screenshot path.
  describe('the export\'s own failure, before cleanup', () => {
    const input = (projectId: string, signal: AbortSignal, encoderClosed: Promise<void>) => ({ executablePath: chromeBin, origin, target: { projectId, jobId: 'failure' },
      resolution: { width: 320, height: 180 }, fps: { num: 30, den: 1 }, frames: 1, quality: 'high' as const, signal, write: async () => undefined, encoderClosed,
      referenceFrames: new Set<number>(), reference: async () => undefined, progress: () => undefined });

    it('FFmpeg ending while the drawing page opens, then a cancel: FFmpeg\'s reason rather than the closed page, marked', async () => {
      const controller = new AbortController();
      let encoderEnded!: (error: Error) => void;
      const encoderClosed = new Promise<void>((_resolve, reject) => { encoderEnded = reject; });
      let opening = false;
      requested.set('never-ready', () => {
        opening = true;
        encoderEnded(new Error('試験: 描画画面を開く途中で FFmpeg が終了'));
        // After the export has seen it (the rejection's handlers run first) and while its browser closes.
        setImmediate(() => controller.abort());
      });
      const error = await renderCanvasExport(input('never-ready', controller.signal, encoderClosed)).then(() => undefined, value => value as Error);
      expect(opening).toBe(true);
      expect(error?.message).toBe('試験: 描画画面を開く途中で FFmpeg が終了');
      expect(isExportFailure(error)).toBe(true);
    }, 60_000);

    it('a browser that cannot start: that reason, marked', async () => {
      const error = await renderCanvasExport({ ...input('bits-320x180', new AbortController().signal, new Promise(() => undefined)), executablePath: join(work, 'no-such-chrome'), launch: { attempts: 1 } })
        .then(() => undefined, value => value as Error);
      expect(error?.message).toMatch(/^書き出し用のブラウザを起動できませんでした（1 回試しました）/);
      expect(isExportFailure(error)).toBe(true);
    }, 60_000);

    it('a cancel stays a cancel: the stop reason, not marked', async () => {
      const controller = new AbortController();
      requested.set('never-ready', () => { setImmediate(() => controller.abort()); });
      const error = await renderCanvasExport(input('never-ready', controller.signal, new Promise(() => undefined))).then(() => undefined, value => value as unknown);
      expect(error).toBe(controller.signal.reason);
      expect(isExportFailure(error)).toBe(false);
    }, 60_000);
  });
});

describe.skipIf(!available)('the product path: dev server, a real project, POST /api/sequence/export', () => {
  let work = '', projects = '', origin = '', server: ViteDevServer | undefined;
  const saved = { HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT, HARNESS_LEARNING_HOME: process.env.HARNESS_LEARNING_HOME, HARNESS_PREFERENCE_TEST_FIXTURE: process.env.HARNESS_PREFERENCE_TEST_FIXTURE, SME_NO_OPEN: process.env.SME_NO_OPEN };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  /** A project made from a lavfi test pattern with a tone, through the product's own project creation. */
  async function createProject(name: string, seconds: number): Promise<{ id: string; directory: string; source: string }> {
    const source = join(work, `${name}.mp4`);
    execFileSync(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(seconds), '-c:v', 'libx264', '-g', '30', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
    const created = await fetch(`${origin}/api/create-project?native=1&name=${name}&video=${name}.mp4`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: await readFile(source) });
    const text = await created.text(); expect(created.status, text).toBe(200);
    const id: string = JSON.parse(text).id;
    return { id, directory: join(projects, id), source };
  }
  async function openSession(id: string): Promise<{ sessionId: string; document: SequenceDocument }> {
    const opened = await post(`/api/sequence/session?id=${encodeURIComponent(id)}`, {}); expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return opened.body;
  }
  const status = async (id: string, job: string): Promise<NativeExportStatus> => (await fetch(`${origin}/api/sequence/export/status?id=${encodeURIComponent(id)}&job=${job}`)).json();
  async function startExport(id: string, settings: Record<string, string>): Promise<NativeExportStatus> {
    const state = await openSession(id);
    const started = await post(`/api/sequence/export?id=${encodeURIComponent(id)}`, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: `canvas-e2e-${randomUUID()}`, settings });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    return started.body;
  }
  async function until(id: string, job: NativeExportStatus, done: (value: NativeExportStatus) => boolean, ms = 150_000): Promise<NativeExportStatus> {
    const began = performance.now();
    while (!done(job)) {
      if (performance.now() - began > ms) throw new Error(`書き出しが ${ms / 1000} 秒で目的の状態になりません: ${JSON.stringify(job)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
      job = await status(id, job.id);
    }
    return job;
  }
  const ended = (job: NativeExportStatus) => ['complete', 'failed', 'cancelled'].includes(job.phase);

  let small: { id: string; directory: string; source: string; frames: number }, long: { id: string; directory: string };
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'harness-export-canvas-')); projects = join(work, 'projects');
    await mkdir(projects);
    Object.assign(process.env, { HARNESS_PROJECT_ROOT: projects, HARNESS_LEARNING_HOME: join(work, 'learning'), HARNESS_PREFERENCE_TEST_FIXTURE: '1', SME_NO_OPEN: '1' });
    const { createServer } = await import('vite');
    // This test's own dependency cache: a shared one is rewritten by any other run on the machine.
    server = await createServer({ root, cacheDir: join(work, 'vite'), logLevel: 'warn', server: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
    await server.listen();
    const address = server.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('検証サーバーを起動できません');
    origin = `http://127.0.0.1:${address.port}`;
    // 3 s at 29.97 fps with a caption over the video: translucent band and layer, blurred entrance, blurred shadow, rotated.
    const made = await createProject('canvas', 3);
    const store = new SequenceStore(made.directory), loaded = store.load(); if (!loaded) throw new Error('作った案件を読めません');
    const document = loaded.document, frames = document.sequenceEndFrame;
    const caption: SequenceClip = { id: 'caption', name: '字幕', trackId: 'caption-track', startFrame: 0, durationFrames: frames,
      clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: frames, den: 1 } },
      visual: { layout: { ...DEFAULT_MAIN_LAYOUT, rotation: -4 }, opacity: 0.85, keyframes: [] },
      content: { kind: 'telop', data: { text: '速い書き出しの確認', position: { x: 0, y: -0.5 }, animation: 'fadeBlurFromBottom' },
        appearance: { ...DEFAULT_TEXT_APPEARANCE, fontSize: 28, band: { color: '#10204099', padX: 16, padY: 8, radius: 8 }, shadow: { x: 2, y: 3, blur: 4, color: '#000000cc' } } } };
    store.save({ expectedSavedRevision: loaded.savedRevision, executionId: 'canvas-caption', document: { ...document, revision: document.revision + 1,
      // Later tracks draw on top (ScenePlan.frame): after the video, or the video hides the caption.
      tracks: [...document.tracks, { id: 'caption-track', kind: 'visual', name: '字幕', enabled: true }], clips: [...document.clips, caption] } });
    expect((await openSession(made.id)).document.clips).toHaveLength(document.clips.length + 1);
    small = { ...made, frames };
    // 20 s (600 frames): long enough to cancel or break an export while it draws.
    long = await createProject('long', 20);
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (work) await rm(work, { recursive: true, force: true });
  });

  async function exportWith(settings: Record<string, string>) {
    const began = performance.now();
    const job = await until(small.id, await startExport(small.id, settings), ended);
    expect(job.phase, JSON.stringify(job)).toBe('complete');
    const directory = join(small.directory, '.harness', 'exports', job.id);
    return { mp4: join(directory, 'output.mp4'), verification: JSON.parse(await readFile(join(directory, 'verification.json'), 'utf8')), ms: Math.round(performance.now() - began) };
  }

  it('exports a captioned project as the screenshot path does: frames, no reordering, colour tags, audio, every frame PSNR ≥ 35 dB', async () => {
    const capture = await exportWith({ resolution: 'full', quality: 'high' });
    const canvas = await exportWith({ resolution: 'full', quality: 'high', engine: 'canvas' });
    const frames = small.frames;
    expect(capture.verification.engine).toBeUndefined();
    expect(canvas.verification).toMatchObject({ engine: 'canvas', settings: { resolution: 'full', quality: 'high', engine: 'canvas' }, intermediate: { format: 'h264' },
      parallel: { workers: 1, blockFrames: 60 }, encoder: { quantizer: 22, keyFrameInterval: 60 } });
    expect(canvas.verification.references.map((reference: { frame: number }) => reference.frame)).toEqual([0, Math.floor(frames / 2), frames - 1]);
    expect(frameCount(ffprobeBin, canvas.mp4)).toBe(frames);
    expect(frameCount(ffprobeBin, capture.mp4)).toBe(frames);
    const streams = JSON.parse(execFileSync(ffprobeBin, ['-v', 'error', '-show_streams', '-of', 'json', canvas.mp4], { encoding: 'utf8' })).streams as Array<Record<string, unknown>>;
    const video = streams.filter(stream => stream.codec_type === 'video'), audio = streams.filter(stream => stream.codec_type === 'audio');
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({ codec_name: 'h264', width: 640, height: 360, has_b_frames: 0, color_space: 'bt709', color_transfer: 'iec61966-2-1', color_primaries: 'bt709', color_range: 'tv' });
    expect(audio).toHaveLength(1); expect(audio[0]).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
    // Presence: the caption is in the picture. Against the uncaptioned source, the frames past its 0.25 s entrance and
    // before its exit measured 23.3–23.9 dB (2026-11-10), frame 0, before the entrance shows anything, 39 dB.
    const fromSource = psnrSeries(ffmpegBin, canvas.mp4, small.source);
    expect(Math.max(...fromSource.slice(10, frames - 10))).toBeLessThan(30);
    const psnr = psnrSeries(ffmpegBin, canvas.mp4, capture.mp4);
    expect(psnr).toHaveLength(frames);
    const minimum = Math.min(...psnr);
    console.info(`[canvas e2e] ${frames} frames: capture ${capture.ms} ms, canvas ${canvas.ms} ms; PSNR min ${minimum.toFixed(2)} dB (frame ${psnr.indexOf(minimum)}); encoder ${JSON.stringify(canvas.verification.encoder)}`);
    expect(minimum).toBeGreaterThanOrEqual(35);
  }, 120_000);

  it('offers the canvas engine here, and refuses it at a resolution other than full with the reason', async () => {
    const engines = await fetch(`${origin}/api/sequence/export/engines?id=${encodeURIComponent(small.id)}`);
    expect(await engines.json()).toEqual({ canvas: { available: true } });
    const state = await openSession(small.id);
    const refused = await post(`/api/sequence/export?id=${encodeURIComponent(small.id)}`, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: `canvas-e2e-${randomUUID()}`,
      settings: { resolution: '1080p', quality: 'high', engine: 'canvas' } });
    expect(refused).toMatchObject({ status: 400, body: { error: '速い書き出しは解像度「そのまま」の時だけ使えます' } });
  }, 30_000);

  /** Start a canvas export of the long project, act once it has drawn a block, and return the ended job with what
   * it left: the processes it had started still running, and the files in its folder. */
  async function interrupted(act: (job: NativeExportStatus, running: Array<{ pid: number; command: string }>) => Promise<void>) {
    const before = new Set(descendants().map(row => row.pid));
    const drawing = await until(long.id, await startExport(long.id, { resolution: 'full', quality: 'high', engine: 'canvas' }),
      job => ended(job) || job.phase === 'rendering' && job.completedFrames >= CANVAS_KEY_FRAME_INTERVAL + 1);
    expect(drawing.phase, JSON.stringify(drawing)).toBe('rendering');
    const running = descendants().filter(row => !before.has(row.pid));
    // Presence: the export's own browser and FFmpeg were there to stop.
    expect(running.filter(isChromeMain), JSON.stringify(running)).toHaveLength(1);
    expect(running.filter(isCanvasFfmpeg), JSON.stringify(running)).toHaveLength(1);
    await act(drawing, running);
    const job = await until(long.id, drawing, ended, 60_000);
    const left = await gone(running.map(row => row.pid));
    return { job, left, newcomers: descendants().filter(row => !before.has(row.pid)), files: await readdir(join(long.directory, '.harness', 'exports', job.id)) };
  }
  const noOutput = (files: string[]) => { for (const file of ['output.mp4', exportScratchFiles.partial, exportScratchFiles.audio]) expect(files).not.toContain(file); };

  it('a cancel while drawing: cancelled, no browser or FFmpeg left, no output.mp4 and no scratch file', async () => {
    const { job, left, newcomers, files } = await interrupted(async drawing => {
      expect((await post(`/api/sequence/export/cancel?id=${encodeURIComponent(long.id)}&job=${drawing.id}`, {})).status).toBe(200);
    });
    expect(job.phase, JSON.stringify(job)).toBe('cancelled');
    expect(job.completedFrames).toBeLessThan(job.totalFrames);
    expect(left).toEqual([]); expect(newcomers).toEqual([]); noOutput(files);
  }, 120_000);

  it('FFmpeg ending mid-export: failed with the encoder\'s reason, no browser left, no output.mp4 and no scratch file', async () => {
    const { job, left, newcomers, files } = await interrupted(async (_drawing, running) => { process.kill(running.find(isCanvasFfmpeg)!.pid, 'SIGKILL'); });
    expect(job.phase, JSON.stringify(job)).toBe('failed');
    expect(job.error).toMatch(/^動画の符号化/);
    expect(left).toEqual([]); expect(newcomers).toEqual([]); noOutput(files);
  }, 120_000);

  it('FFmpeg ending mid-export, then a cancel while the browser is still closing: still failed with the encoder\'s reason', async () => {
    const { job, left, newcomers, files } = await interrupted(async (drawing, running) => {
      // Closing a browser can take up to 10 s. Holding it keeps the export in that cleanup until the cancel has arrived.
      const browser = running.find(isChromeMain)!.pid, encoder = running.find(isCanvasFfmpeg)!.pid;
      process.kill(browser, 'SIGSTOP');
      try {
        process.kill(encoder, 'SIGKILL');
        // The server runs in this process: FFmpeg reaped here means the export has been told it ended.
        expect(await gone([encoder])).toEqual([]);
        await new Promise(resolve => setTimeout(resolve, 300));
        const cancel = await post(`/api/sequence/export/cancel?id=${encodeURIComponent(long.id)}&job=${drawing.id}`, {});
        // Presence: the cancel reached the export while it was still running.
        expect(cancel).toMatchObject({ status: 200, body: { phase: 'rendering' } });
      } finally { process.kill(browser, 'SIGCONT'); }
    });
    expect(job.phase, JSON.stringify(job)).toBe('failed');
    expect(job.error).toMatch(/^動画の符号化/);
    expect(left).toEqual([]); expect(newcomers).toEqual([]); noOutput(files);
  }, 120_000);

  it('Chrome ending mid-export: failed with that reason in Japanese, FFmpeg stopped, no output.mp4 and no scratch file', async () => {
    const { job, left, newcomers, files } = await interrupted(async (_drawing, running) => { process.kill(running.find(isChromeMain)!.pid, 'SIGKILL'); });
    expect(job.phase, JSON.stringify(job)).toBe('failed');
    expect(job.error).toBe('書き出し用のブラウザが途中で終了しました');
    expect(left).toEqual([]); expect(newcomers).toEqual([]); noOutput(files);
  }, 120_000);
});
