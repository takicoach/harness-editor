import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRgba, startEditorServer } from '../../../scripts/native-render-capture';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import type { ThumbnailCommand } from '../../core/thumbnail/commands';
import { defaultThumbnailVisual, type ThumbnailContent, type ThumbnailLayer, type ThumbnailVisual } from '../../core/thumbnail/model';
import { thumbnailTextAppearance } from '../../core/thumbnail/textStyles';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { importSequenceAsset } from '../sequence/assets';
import { SequenceStore } from '../sequence/store';
import type { ThumbnailExportStatus } from './exports';
import type { ThumbnailSessionState } from './service';
import { ThumbnailStore } from './store';

const ffmpeg = resolveFfmpegBin(), available = resolveNativeChromiumBin().ok && ffmpeg.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('サムネの受け入れ検証に Chromium と FFmpeg が必要です');
type RGB = readonly [number, number, number];
const projectId = 'thumb-accept';
const FRAME_COLORS: readonly RGB[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
const hex = (color: RGB) => color.map(value => value.toString(16).padStart(2, '0')).join('');
const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const parseHex = (value: string): RGB => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
let root = '', project = '', work = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined;
let video: SequenceAsset, split: SequenceAsset, red: SequenceAsset, cutout: SequenceAsset, state: ThumbnailSessionState;

function videoDocument(asset: SequenceAsset): SequenceDocument {
  const stream = asset.streams.find(item => item.kind === 'video')!;
  return { schemaVersion: 2, id: 'accept-video', name: '受け入れ', revision: 0, fps: { num: 10, den: 1 }, resolution: { width: 320, height: 180 }, sequenceEndFrame: 6,
    background: '#000000', assets: [asset], tracks: [{ id: 'v', name: '映像', kind: 'visual', enabled: true }],
    clips: [{ id: 'clip', trackId: 'v', name: '映像', startFrame: 0, durationFrames: 6, clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 6, den: 1 } },
      visual: { layout: { ...DEFAULT_MAIN_LAYOUT }, opacity: 1, keyframes: [] },
      content: { kind: 'video', assetId: asset.id, streamIndex: stream.index, sourceIn: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, endBehavior: 'hold' } }],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
async function call<T>(base: string, route: string, body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(`${server!.origin}${base}${route}${route.includes('?') ? '&' : '?'}id=${projectId}`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (response.status !== expected) throw new Error(`${base}${route}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
const api = <T>(route: string, body?: unknown, expected = 200) => call<T>('/api/thumbnail', route, body, expected);
const ids = () => ({ sessionId: state.sessionId, expectedRevision: state.document.revision, expectedSavedRevision: state.savedRevision });
async function command(item: ThumbnailCommand): Promise<void> {
  state = await api('/command', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command: item });
}
function layer(id: string, content: ThumbnailContent, visual: Partial<ThumbnailVisual> = {}): ThumbnailLayer {
  return { id, name: id, hidden: false, locked: false, content, visual: { ...defaultThumbnailVisual(), ...visual } };
}
const clearPage = (pageId: string): ThumbnailCommand[] => {
  const layers = state.document.pages.find(page => page.id === pageId)!.layers;
  return layers.length ? [{ type: 'delete-layers', pageId, layerIds: layers.map(item => item.id) }] : [];
};
async function exportPage(pageId: string): Promise<{ status: ThumbnailExportStatus; at(x: number, y: number): RGB; count(rect: { x: number; y: number; width: number; height: number }, color: string): number }> {
  const executionId = crypto.randomUUID();
  let status = await api<ThumbnailExportStatus>('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId, pageId, format: 'png' });
  const deadline = Date.now() + 90_000;
  while (status.phase === 'checking' || status.phase === 'rendering') {
    if (Date.now() > deadline) throw new Error('書き出しが終わりません');
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await api(`/export/status?executionId=${executionId}`);
  }
  if (status.phase !== 'complete') throw new Error(`書き出しに失敗: ${status.error}`);
  const width = state.document.canvas.width, rgba = decodeRgba(readFileSync(join(project, status.fileName!)));
  const at = (x: number, y: number): RGB => { const index = (Math.round(y) * width + Math.round(x)) * 4; return [rgba[index]!, rgba[index + 1]!, rgba[index + 2]!]; };
  const count = (rect: { x: number; y: number; width: number; height: number }, color: string) => {
    const target = parseHex(color); let total = 0;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) if (distance(at(x, y), target) < 60) total++;
    return total;
  };
  return { status, at, count };
}

beforeAll(async () => {
  if (!available || !ffmpeg.ok) return;
  root = mkdtempSync(join(tmpdir(), 'thumb-accept-')); project = join(root, projectId); work = join(root, 'work');
  mkdirSync(project); mkdirSync(work);
  const run = (args: string[]) => execFileSync(ffmpeg.bin, ['-v', 'error', ...args]);
  // コマごとに色が違う 6 コマの動画（10fps）。
  FRAME_COLORS.forEach((color, index) => run(['-f', 'lavfi', '-i', `color=c=0x${hex(color)}:s=320x180`, '-frames:v', '1', join(work, `f${index}.png`)]));
  run(['-framerate', '10', '-i', join(work, 'f%d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', '-crf', '10', join(work, 'frames.mp4')]);
  // 左がオレンジ・右が青（反転の確認）、赤一色（彩度の確認）、透明地に緑の四角（白フチの確認）。
  run(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=100x50', '-vf', 'drawbox=x=0:y=0:w=50:h=50:color=0xff8000:t=fill', '-frames:v', '1', join(work, 'split.png')]);
  run(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=64x64', '-frames:v', '1', join(work, 'red.png')]);
  run(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=100x100,format=rgba', '-vf', 'drawbox=x=25:y=25:w=50:h=50:color=0x00ff00@1:t=fill:replace=1', '-frames:v', '1', join(work, 'cutout.png')]);
  video = await importSequenceAsset(project, join(work, 'frames.mp4'), 'frames.mp4');
  split = await importSequenceAsset(project, join(work, 'split.png'), 'split.png');
  red = await importSequenceAsset(project, join(work, 'red.png'), 'red.png');
  cutout = await importSequenceAsset(project, join(work, 'cutout.png'), 'cutout.png');
  new SequenceStore(project).save({ expectedSavedRevision: null, executionId: 'video', document: videoDocument(video) });
  server = await startEditorServer(process.cwd(), root);
}, 240_000);
afterAll(async () => { await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!available)('サムネの受け入れ（画面なし）', () => {
  it('[1] 作成・取り込み・編集・保存・書き出しは project.v2.json もその指紋も変えない', async () => {
    const file = join(project, '.harness', 'project.v2.json'), before = readFileSync(file), saved = new SequenceStore(project).load()!;
    state = await api('/create', { executionId: 'create' });
    const upload = await fetch(`${server!.origin}/api/thumbnail/upload?id=${projectId}&name=extra.png`, { method: 'POST', body: readFileSync(join(work, 'red.png')) });
    expect(upload.status).toBe(200);
    state = await api('/register', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'register', assetIds: [video.id, split.id, red.id, cutout.id] });
    const pageId = state.document.pages[0]!.id;
    await command({ type: 'add-layer', pageId, layer: layer('title', { kind: 'text', text: '確認', appearance: thumbnailTextAppearance(120) }) });
    state = await api('/save', { ...ids(), executionId: 'save-a' });
    await exportPage(pageId);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(new SequenceStore(project).load()!.contentHash).toBe(saved.contentHash);
  }, 180_000);

  it('[7] 選んだコマの模様だけが写り、前後のコマの模様は写らない', async () => {
    const pageId = state.document.pages[0]!.id, stream = video.streams.find(item => item.kind === 'video')!;
    const frame = (index: number): ThumbnailContent => ({ kind: 'video-frame', assetId: video.id, streamIndex: stream.index, fingerprint: video.fingerprint, sourceTime: { num: 2 * index + 1, den: 20 } });
    await command({ type: 'batch', commands: [...clearPage(pageId), { type: 'add-layer', pageId, layer: layer('frame', frame(1)) }] });
    for (const index of [1, 3, 4]) {
      await command({ type: 'update-layer', pageId, layerId: 'frame', patch: { content: frame(index) } });
      const { at } = await exportPage(pageId), color = at(640, 360);
      expect(distance(color, FRAME_COLORS[index]!), `コマ ${index}`).toBeLessThan(60);
      expect(distance(color, FRAME_COLORS[index - 1]!), `コマ ${index} の前`).toBeGreaterThan(150);
      expect(distance(color, FRAME_COLORS[index + 1]!), `コマ ${index} の後`).toBeGreaterThan(150);
    }
  }, 180_000);

  it('[6] 2 重の袋文字・帯・白フチ・画像の色調整・反転が、書き出した PNG に写る', async () => {
    const pageId = state.document.pages[0]!.id, gray = '#808080';
    const outlined = { ...thumbnailTextAppearance(160), color: '#ffe600', outlines: [{ width: 10, color: '#000000' }, { width: 10, color: '#ffffff' }] };
    const banded = { ...thumbnailTextAppearance(100), band: { color: '#ff00ff', padX: 24, padY: 8, radius: 4 } };
    await command({ type: 'batch', commands: [...clearPage(pageId),
      { type: 'add-layer', pageId, layer: layer('bg', { kind: 'shape', shape: { kind: 'rect', width: 1280, height: 720, color: gray, strokeWidth: 0, cornerRadius: 0, fill: { kind: 'solid', color: gray } } }) },
      { type: 'add-layer', pageId, layer: layer('flip', { kind: 'image', assetId: split.id, role: 'element' }, { position: { x: -.6, y: -.5 }, scale: .3, flipX: true }) },
      { type: 'add-layer', pageId, layer: layer('gray', { kind: 'image', assetId: red.id, role: 'photo' }, { position: { x: .6, y: -.5 }, scale: .2, color: { brightness: 0, contrast: 0, saturation: -100, temperature: 0 } }) },
      { type: 'add-layer', pageId, layer: layer('edge', { kind: 'image', assetId: cutout.id, role: 'element' }, { position: { x: 0, y: -.5 }, scale: .3, edge: { width: 12, color: '#ffffff' } }) },
      { type: 'add-layer', pageId, layer: layer('outline', { kind: 'text', text: 'ABC', appearance: outlined }, { position: { x: -.45, y: .45 } }) },
      { type: 'add-layer', pageId, layer: layer('band', { kind: 'text', text: 'BAND', appearance: banded }, { position: { x: .5, y: .45 } }) }] });
    const { at, count } = await exportPage(pageId);
    // 反転: 元は左がオレンジ・右が青。箱は中心 (256,180)・幅 384 なので、左寄り 160 が青、右寄り 352 がオレンジ。
    expect(distance(at(160, 180), [0, 0, 255])).toBeLessThan(60);
    expect(distance(at(352, 180), [255, 128, 0])).toBeLessThan(60);
    // 色調整（彩度 -100）: 赤が灰色になる。
    const grayed = at(1024, 180);
    expect(Math.max(...grayed) - Math.min(...grayed)).toBeLessThan(16);
    // 白フチ: 緑の四角（中心 640・幅 108）のすぐ外（6px）が白く、26px 外は地の灰色。
    expect(distance(at(640, 180), [0, 255, 0])).toBeLessThan(60);
    expect(distance(at(700, 180), [255, 255, 255])).toBeLessThan(60);
    expect(distance(at(720, 180), parseHex(gray))).toBeLessThan(30);
    // 2 重の袋文字: 灰色の地の上に、黄（塗り）・黒（内側）・白（外側）がそろって出る。
    const text = { x: 152, y: 422, width: 400, height: 200 };
    expect(count(text, '#ffe600')).toBeGreaterThan(500);
    expect(count(text, '#000000')).toBeGreaterThan(300);
    expect(count(text, '#ffffff')).toBeGreaterThan(300);
    // 帯
    expect(count({ x: 760, y: 440, width: 400, height: 160 }, '#ff00ff')).toBeGreaterThan(2000);
  }, 180_000);

  it('[8] 案ごとの要素は、複製・表示・ロック・重なり順・削除・並べ替えで他の案を変えず、書き出しはそれぞれの内容になる', async () => {
    const pageA = state.document.pages[0]!.id;
    const rect = (id: string, color: string) => layer(id, { kind: 'shape', shape: { kind: 'rect', width: 400, height: 300, color, strokeWidth: 0, cornerRadius: 0, fill: { kind: 'solid', color } } });
    await command({ type: 'batch', commands: [...clearPage(pageA), { type: 'add-layer', pageId: pageA, layer: rect('a-rect', '#ff0000') }] });
    const snapshotA = () => JSON.stringify(state.document.pages.find(page => page.id === pageA));
    const before = snapshotA();
    await command({ type: 'add-page', pageId: 'page-b', name: '案B', duplicateOf: pageA });
    const bRect = state.document.pages.find(page => page.id === 'page-b')!.layers[0]!.id;
    await command({ type: 'update-layer', pageId: 'page-b', layerId: bRect, patch: { content: rect('x', '#00ff00').content } });
    await command({ type: 'add-page', pageId: 'page-c', name: '案C' });
    await command({ type: 'batch', commands: [{ type: 'add-layer', pageId: 'page-c', layer: rect('c-rect', '#0000ff') }, { type: 'add-layer', pageId: 'page-c', layer: rect('c-extra', '#ffffff') }] });
    await command({ type: 'set-layer-flags', pageId: 'page-c', layerId: 'c-extra', hidden: true, locked: true });
    await command({ type: 'reorder-layer', pageId: 'page-c', layerId: 'c-extra', index: 0 });
    await command({ type: 'delete-layers', pageId: 'page-c', layerIds: ['c-extra'] });
    await command({ type: 'reorder-page', pageId: 'page-c', index: 0 });
    await command({ type: 'rename-page', pageId: 'page-b', name: 'みどり' });
    expect(snapshotA()).toBe(before);
    for (const [pageId, color] of [[pageA, [255, 0, 0]], ['page-b', [0, 255, 0]], ['page-c', [0, 0, 255]]] as const) {
      const { at, status } = await exportPage(pageId);
      expect(distance(at(640, 360), color), status.pageName).toBeLessThan(40);
    }
  }, 240_000);

  it('[4] HTTP で拒否した要求は、文書と元に戻す履歴を変えない', async () => {
    const before = await api<ThumbnailSessionState>('/session/status', { sessionId: state.sessionId });
    for (const item of [{ type: 'batch', commands: Array.from({ length: 51 }, () => ({ type: 'rename-page', pageId: 'page-b', name: 'x' })) },
      { type: 'explode' }, { type: 'rename-page', pageId: 'page-b', name: '' }]) {
      await api('/command', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command: item }, 400);
    }
    const after = await api<ThumbnailSessionState>('/session/status', { sessionId: state.sessionId });
    expect(after.document).toEqual(before.document);
    expect([after.canUndo, after.canRedo]).toEqual([before.canUndo, before.canRedo]);
  });

  it('[2] 動画とサムネを同時に保存しても 409 にならない', async () => {
    type VideoState = { sessionId: string; document: SequenceDocument; savedRevision: number };
    const opened = await call<VideoState>('/api/sequence', '/session', {});
    const edited = await call<VideoState>('/api/sequence', '/command', { sessionId: opened.sessionId, expectedRevision: opened.document.revision, executionId: crypto.randomUUID(),
      command: { type: 'update-clip', clipId: 'clip', patch: { name: '同時保存' } } });
    await command({ type: 'rename-page', pageId: 'page-b', name: '同時' });
    const post = (route: string, body: unknown) => fetch(`${server!.origin}${route}?id=${projectId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const [videoSave, thumbnailSave] = await Promise.all([
      post('/api/sequence/save', { sessionId: edited.sessionId, expectedRevision: edited.document.revision, expectedSavedRevision: edited.savedRevision, executionId: crypto.randomUUID() }),
      post('/api/thumbnail/save', { ...ids(), executionId: crypto.randomUUID() })]);
    expect([videoSave.status, thumbnailSave.status]).toEqual([200, 200]);
    state = await thumbnailSave.json() as ThumbnailSessionState;
  });

  it('[10] 再送は二重保存にならず、持ち主の無いロックは回収・使用中は奪わない・壊れたら保全・衝突は退避', async () => {
    const store = new ThumbnailStore(project);
    await command({ type: 'rename-page', pageId: 'page-b', name: '再送' });
    const retry = { ...ids(), executionId: 'retry-save' };
    const first = await api<ThumbnailSessionState & { replayed: boolean }>('/save', retry), second = await api<ThumbnailSessionState & { replayed: boolean }>('/save', retry);
    expect([first.replayed, second.replayed]).toEqual([false, true]);
    expect((JSON.parse(readFileSync(store.file, 'utf8')).receipts as Array<{ executionId: string }>).filter(item => item.executionId === 'retry-save')).toHaveLength(1);
    state = second;
    writeFileSync(store.lockFile, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: '2026-10-03T00:00:00.000Z' }));
    await command({ type: 'rename-page', pageId: 'page-b', name: '回収' });
    state = await api('/save', { ...ids(), executionId: 'stale-lock' });
    expect(existsSync(store.lockFile)).toBe(false);
    writeFileSync(store.lockFile, JSON.stringify({ pid: server!.pid, startedAt: new Date().toISOString() }));
    await command({ type: 'rename-page', pageId: 'page-b', name: '使用中' });
    await api('/save', { ...ids(), executionId: 'live-lock' }, 409);
    expect(JSON.parse(readFileSync(store.lockFile, 'utf8')).pid).toBe(server!.pid);
    rmSync(store.lockFile);
    state = await api('/save', { ...ids(), executionId: 'after-lock' });
    await command({ type: 'rename-page', pageId: 'page-b', name: '未保存' });
    const saved = store.load();
    if (saved.kind !== 'ok') throw new Error('保存済みのサムネがありません');
    store.save({ expectedSavedRevision: saved.saved.savedRevision, executionId: 'outside', document: { ...saved.saved.document, revision: saved.saved.document.revision + 1 } });
    const conflict = await api<{ evacuatedFile: string }>('/save', { ...ids(), executionId: 'conflict' }, 409);
    const evacuated = JSON.parse(readFileSync(join(project, '.harness', conflict.evacuatedFile), 'utf8')) as { document: { pages: Array<{ name: string }> } };
    expect(evacuated.document.pages.some(page => page.name === '未保存')).toBe(true);
    writeFileSync(store.file, '{');
    const broken = await api<{ code: string; preservedFile: string }>('/session', {}, 409);
    expect(broken.code).toBe('THUMBNAIL_BROKEN');
    expect(readFileSync(join(project, '.harness', broken.preservedFile), 'utf8')).toBe('{');
    state = await api('/recover', { choice: 'backup', executionId: 'recover' });
    expect(state.document.pages.length).toBeGreaterThan(0);
  }, 120_000);
});
