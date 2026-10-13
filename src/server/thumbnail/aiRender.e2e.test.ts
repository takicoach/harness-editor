import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRgba, startEditorServer } from '../../../scripts/native-render-capture';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { applyThumbnailCommand } from '../../core/thumbnail/commands';
import { thumbnailFixture, shapeLayer } from '../../core/thumbnail/fixtures';
import type { ThumbnailDocument, ThumbnailLayer } from '../../core/thumbnail/model';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { importSequenceAsset } from '../sequence/assets';
import { SequenceStore } from '../sequence/store';
import { thumbnailAiRender } from './aiRender';
import { handleThumbnailApi } from './api';

const ffmpeg = resolveFfmpegBin(), available = resolveNativeChromiumBin().ok && ffmpeg.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('サムネの AI の描画の検証に Chromium と FFmpeg が必要です');
type RGB = readonly [number, number, number];
const projectId = 'thumb-ai-render';
const FRAME_COLORS: readonly RGB[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
const hex = (color: RGB) => color.map(value => value.toString(16).padStart(2, '0')).join('');
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const RED: RGB = [255, 59, 48];
let root = '', project = '', work = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined, proxy: { origin: string; close(): Promise<void> } | undefined;
let video: SequenceAsset;

function centerColor(bytes: Buffer, size: { width: number; height: number }): RGB {
  const rgba = decodeRgba(bytes), index = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
  expect(rgba.length).toBe(size.width * size.height * 4);
  return [rgba[index]!, rgba[index + 1]!, rgba[index + 2]!];
}
function videoDocument(asset: SequenceAsset): SequenceDocument {
  const stream = asset.streams.find(item => item.kind === 'video')!;
  return { schemaVersion: 2, id: 'ai-render-video', name: 'AI 描画', revision: 0, fps: { num: 10, den: 1 }, resolution: { width: 320, height: 180 }, sequenceEndFrame: 6,
    background: '#000000', assets: [asset], tracks: [{ id: 'v', name: '映像', kind: 'visual', enabled: true }],
    clips: [{ id: 'clip', trackId: 'v', name: '映像', startFrame: 0, durationFrames: 6, clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 6, den: 1 } },
      visual: { layout: { ...DEFAULT_MAIN_LAYOUT }, opacity: 1, keyframes: [] },
      content: { kind: 'video', assetId: asset.id, streamIndex: stream.index, sourceIn: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, endBehavior: 'hold' } }],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
const headerLines = (headers: IncomingHttpHeaders, from: string, to: string) => Object.entries(headers).flatMap(([name, value]) =>
  (Array.isArray(value) ? value : [value ?? '']).map(item => `${name}: ${name === 'host' ? new URL(to).host : item.split(from).join(to)}`));
/**
 * 描画する入力は「呼び出した側のプロセス」の ThumbnailRenderInputs に登録される。dev サーバーは別プロセスなので、
 * 描画ページの入力取得（/api/thumbnail/export/input・asset）だけをこのプロセスの本物の API で答え、残りは dev サーバーへ素通しする。
 */
async function startInputProxy(viteOrigin: string, projectRoot: string): Promise<{ origin: string; close(): Promise<void> }> {
  const vite = new URL(viteOrigin);
  const proxyServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/api/thumbnail/export/input' || url.pathname === '/api/thumbnail/export/asset')) {
      void handleThumbnailApi(req, res, url, projectRoot).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const origin = `http://${req.headers.host}`;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, name === 'host' ? vite.host
      : Array.isArray(value) ? value.map(item => item.split(origin).join(viteOrigin)) : value?.split(origin).join(viteOrigin)]));
    const upstream = httpRequest({ host: vite.hostname, port: vite.port, method: req.method, path: req.url, headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxyServer.on('upgrade', (req, socket, head) => {
    const upstream = netConnect(Number(vite.port), vite.hostname, () => {
      upstream.write([`${req.method} ${req.url} HTTP/1.1`, ...headerLines(req.headers, `http://${req.headers.host}`, viteOrigin), '', ''].join('\r\n'));
      upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>(resolve => { proxyServer.closeAllConnections(); proxyServer.close(() => resolve()); }) };
}
const files = (directory: string): string[] => readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort();

beforeAll(async () => {
  if (!available || !ffmpeg.ok) return;
  root = mkdtempSync(join(tmpdir(), 'thumb-ai-render-')); project = join(root, projectId); work = join(root, 'work');
  mkdirSync(project); mkdirSync(work);
  const run = (args: string[]) => execFileSync(ffmpeg.bin, ['-v', 'error', ...args]);
  // コマごとに色が違う 6 コマの動画（10fps・320×180）。
  FRAME_COLORS.forEach((color, index) => run(['-f', 'lavfi', '-i', `color=c=0x${hex(color)}:s=320x180`, '-frames:v', '1', join(work, `f${index}.png`)]));
  run(['-framerate', '10', '-i', join(work, 'f%d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', '-crf', '10', join(work, 'frames.mp4')]);
  video = await importSequenceAsset(project, join(work, 'frames.mp4'), 'frames.mp4');
  new SequenceStore(project).save({ expectedSavedRevision: null, executionId: 'video', document: videoDocument(video) });
  server = await startEditorServer(process.cwd(), root);
  proxy = await startInputProxy(server.origin, root);
}, 240_000);
afterAll(async () => { await proxy?.close(); await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!available)('サムネの AI の描画（本物の Chromium と FFmpeg）', () => {
  it('コマ: 指定した秒の色のコマを長辺 640 の JPEG で返す', async () => {
    const stream = video.streams.find(item => item.kind === 'video')!;
    const times = [{ num: 1, den: 20 }, { num: 7, den: 20 }, { num: 11, den: 20 }];   // 0 番・3 番・5 番のフレームの中央
    const started = Date.now();
    const result = await thumbnailAiRender.frames({ directory: project, projectId, origin: proxy!.origin, asset: video, streamIndex: stream.index, times, longSide: 640, signal: new AbortController().signal });
    console.info(`[aiRender.e2e] frames(3 枚) ${Date.now() - started}ms`);
    expect([result.width, result.height]).toEqual([640, 360]);
    expect(result.images.length).toBe(3);
    for (const image of result.images) expect([image[0], image[1]]).toEqual([0xff, 0xd8]);
    const centers = result.images.map(bytes => centerColor(bytes, result));
    expect(distance(centers[0]!, FRAME_COLORS[0]!)).toBeLessThan(40);
    expect(distance(centers[1]!, FRAME_COLORS[3]!)).toBeLessThan(40);
    expect(distance(centers[2]!, FRAME_COLORS[5]!)).toBeLessThan(40);
  }, 180_000);

  it('下書き: 保存していない文書の案を長辺 1280 の PNG で返し、案件のファイルを増やさない', async () => {
    const base = thumbnailFixture(), pageId = base.pages[0]!.id;
    const rect: ThumbnailLayer = { ...shapeLayer('rect'), content: { kind: 'shape', shape: { kind: 'rect', width: 600, height: 400, color: '#ff3b30', strokeWidth: 0, cornerRadius: 0, fill: { kind: 'solid', color: '#ff3b30' } } } };
    const unsavedWithRedRect: ThumbnailDocument = applyThumbnailCommand({ ...base, assets: [], pages: [{ ...base.pages[0]!, layers: [] }] }, { type: 'add-layer', pageId, layer: rect });
    const before = files(project), started = Date.now();
    const result = await thumbnailAiRender.page({ directory: project, projectId, origin: proxy!.origin, document: unsavedWithRedRect, pageId, longSide: 1280, signal: new AbortController().signal });
    console.info(`[aiRender.e2e] page(1280x720) ${Date.now() - started}ms`);
    expect([result.width, result.height]).toEqual([1280, 720]);
    expect([...result.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(distance(centerColor(result.bytes, result), RED)).toBeLessThan(40);
    expect(files(project)).toEqual(before);
  }, 180_000);

  it('下書き: 縦の案（1080×1920）は長辺 1280 に縮めて、中央の図形が写る', async () => {
    const base = thumbnailFixture(), pageId = base.pages[0]!.id;
    const rect: ThumbnailLayer = { ...shapeLayer('rect'), content: { kind: 'shape', shape: { kind: 'rect', width: 600, height: 400, color: '#ff3b30', strokeWidth: 0, cornerRadius: 0, fill: { kind: 'solid', color: '#ff3b30' } } } };
    const portrait = applyThumbnailCommand({ ...base, canvas: { width: 1080, height: 1920 }, assets: [], pages: [{ ...base.pages[0]!, layers: [] }] }, { type: 'add-layer', pageId, layer: rect });
    const result = await thumbnailAiRender.page({ directory: project, projectId, origin: proxy!.origin, document: portrait, pageId, longSide: 1280, signal: new AbortController().signal });
    expect([result.width, result.height]).toEqual([720, 1280]);
    expect(distance(centerColor(result.bytes, result), RED)).toBeLessThan(40);
  }, 180_000);
});
