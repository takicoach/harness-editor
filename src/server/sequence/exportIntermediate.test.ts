// The export's intermediate frames: the product capture ('fast')
// is a JPEG at quality 100 read by FFmpeg as MJPEG, with its BT.601 full-range YUV turned back into the same RGB the
// PNG path had; the measuring capture ('reference') stays PNG. The colours themselves: exportColor.e2e.test.ts.
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { captureFrameFormat, encoderArguments, openRenderSurface, runSequenceExport, EXPORT_JPEG_QUALITY } from './exportRunner';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceDocument } from '../../core/sequence/model';
import type { NativeExportStatus } from '../../shared/nativeExport';
import { rational as r } from '../../core/sequence/time';

const ffmpeg = resolveFfmpegBin();
const still = (codec: 'mjpeg' | 'png', color: string) => {
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  return execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:size=32x32`, '-frames:v', '1',
    ...(codec === 'mjpeg' ? ['-pix_fmt', 'yuvj420p', '-q:v', '1'] : []), '-f', 'image2pipe', '-vcodec', codec, 'pipe:1']);
};
const isJpeg = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

/** A page that draws nothing and records how it was captured. */
function fakeBrowser(image: { jpeg: Buffer; png: Buffer }) {
  const sent: Array<{ method: string; params: unknown }> = [], screenshots: unknown[] = [];
  const page = {
    setDefaultTimeout() {}, on() {}, goto: async () => undefined, evaluate: async () => [32, 32],
    screenshot: async (options: unknown) => { screenshots.push(options); return image.png; },
    context: () => ({ newCDPSession: async () => ({ send: async (method: string, params: unknown) => {
      sent.push({ method, params }); return { data: image.jpeg.toString('base64') };
    } }) }),
    locator: () => ({ elementHandle: async () => ({ contentFrame: async () => ({ waitForFunction: async () => undefined, evaluate: async () => undefined }) }) }),
    close: async () => undefined,
  };
  return { browser: { newPage: async () => page } as unknown as Browser, sent, screenshots };
}

const fake = vi.hoisted(() => ({ jpeg: Buffer.alloc(0), close: vi.fn(async () => {}) }));
vi.mock('playwright-core', () => ({ chromium: { launch: async () => ({ version: () => 'intermediate-test-renderer', close: fake.close, newPage: async () => ({
  setDefaultTimeout() {}, on() {}, goto: async () => undefined, evaluate: async () => [32, 32], screenshot: async () => { throw new Error('the export must not use the reference capture'); },
  context: () => ({ newCDPSession: async () => ({ send: async () => ({ data: fake.jpeg.toString('base64') }) }) }),
  locator: () => ({ elementHandle: async () => ({ contentFrame: async () => ({ waitForFunction: async () => undefined, evaluate: async () => undefined }) }) }),
}) }) } }));
afterEach(() => vi.clearAllMocks());

it('the product capture is JPEG at quality 100; the measuring capture stays PNG', async () => {
  expect(EXPORT_JPEG_QUALITY).toBe(100);
  expect(captureFrameFormat('fast')).toBe('jpeg');
  expect(captureFrameFormat('reference')).toBe('png');
  const image = { jpeg: still('mjpeg', 'red'), png: still('png', 'red') };
  const fast = fakeBrowser(image);
  const captured = await (await openRenderSurface(fast.browser, 'http://fixture.invalid', { projectId: 'p', jobId: 'j' }, { width: 32, height: 32 })).capture(0);
  expect(isJpeg(captured)).toBe(true);
  expect(fast.sent.filter(call => call.method === 'Page.captureScreenshot').map(call => call.params))
    .toEqual([expect.objectContaining({ format: 'jpeg', quality: 100, fromSurface: true, clip: { x: 0, y: 0, width: 32, height: 32, scale: 1 } })]);
  expect(fast.screenshots).toEqual([]);
  const reference = fakeBrowser(image);
  const referenced = await (await openRenderSurface(reference.browser, 'http://fixture.invalid', { projectId: 'p', jobId: 'j' }, { width: 32, height: 32 }, { captureMode: 'reference' })).capture(0);
  expect(isPng(referenced)).toBe(true);
  expect(reference.screenshots).toEqual([{ type: 'png' }]);
});

it('FFmpeg reads each format with its own decoder, and JPEG frames are turned back into RGB as BT.601 full range first', () => {
  const common = { fps: { num: 30, den: 1 }, audioFile: 'a.f32le', filter: 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', crf: 18, output: 'o.mp4' };
  const jpeg = encoderArguments({ ...common, input: 'jpeg' }), png = encoderArguments({ ...common, input: 'png' });
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  expect(after(jpeg, '-vcodec')).toBe('mjpeg');
  expect(after(png, '-vcodec')).toBe('png');
  // RGB in, then exactly the PNG path's filter: resizing and the BT.709 limited-range output stay one code path.
  expect(after(jpeg, '-vf')).toBe(`scale=in_color_matrix=bt601:in_range=pc,format=rgb24,${common.filter}`);
  expect(after(png, '-vf')).toBe(common.filter);
});

it('an export pipes JPEG frames to FFmpeg, keeps its reference frames as .jpg and records the intermediate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-export-intermediate-')), output = join(directory, 'job');
  try {
    await mkdir(output); fake.jpeg = still('mjpeg', 'blue');
    const document: SequenceDocument = { schemaVersion: 2, id: 'case', name: '中間形式', revision: 0, fps: r(30), resolution: { width: 32, height: 32 }, sequenceEndFrame: 3, background: '#000000',
      assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
    const status: NativeExportStatus = { id: 'job', projectId: 'case', revision: 0, contentHash: 'test', executionId: null, phase: 'queued', completedFrames: 0, totalFrames: 3, createdAt: new Date().toISOString() };
    await runSequenceExport({ plan: new ScenePlan(document), projectDirectory: directory, directory: output, origin: 'http://fixture.invalid', status, signal: new AbortController().signal });
    expect((await stat(join(output, 'output.mp4'))).size).toBeGreaterThan(0);
    expect((await readdir(output)).filter(name => name.startsWith('frame-')).sort()).toEqual(['frame-0.jpg', 'frame-1.jpg', 'frame-2.jpg']);
    expect((await readFile(join(output, 'frame-1.jpg'))).equals(fake.jpeg)).toBe(true);
    const verification = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
    expect(verification.intermediate).toEqual({ format: 'jpeg', quality: 100 });
    expect(verification.references.map((entry: { frame: number }) => entry.frame)).toEqual([0, 1, 2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
