import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { importSequenceAsset, registeredSequenceAssets } from './sequence/assets';
import { sequenceExports } from './sequence/exports';
import { resolveFfmpegBin } from './resolveFfmpeg';
import type { MediaStream, SequenceAsset } from '../core/sequence/model';

/**
 * 一時フォルダ掃除（`rm`）を 1 回だけ止めるゲート。応答を返してから後始末が終わるまでの
 * 隙間は実時間では数ミリ秒しかなく、そこへ次の要求を差し込む競合をそのままでは再現できない。
 * 対象は音声補正の作業フォルダだけ（`harness-audio-fix-` 直下）、しかも一発で解除する。
 */
const gate = vi.hoisted(() => ({ hold: null as null | Promise<void> }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof actual.rm = async (path, options) => {
    if (gate.hold && String(path).includes('harness-audio-fix-')) { const held = gate.hold; gate.hold = null; await held; }
    return actual.rm(path, options);
  };
  return { ...actual, default: { ...actual, rm }, rm };
});

let mediaRoot = '', root = '', project = '', origin = '', server: Server, asset: SequenceAsset;

beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'harness-audio-fix-fixture-'));
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'pcm_s16le', join(mediaRoot, 'speech.wav')]);
}, 30000);
afterAll(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-audio-fix-')); project = join(root, 'case');
  await mkdir(project);
  asset = await importSequenceAsset(project, join(mediaRoot, 'speech.wav'), 'speech.wav');
  server = createServer((req, res) => {
    void handleApi(req, res, new URL(req.url!, 'http://localhost'), root).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  gate.hold = null;
  vi.restoreAllMocks();
  delete process.env.HARNESS_FFMPEG;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

const post = (body: unknown, id = 'case') => fetch(`${origin}/api/audio-fix?${new URLSearchParams({ id })}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = async () => (await (await fetch(`${origin}/api/audio-fix/status?${new URLSearchParams({ id: 'case' })}`)).json()) as { running: string | null };
/** 実行中を確実に観測してから 2 本目を撃つ（時間ではなく状態で待つ）。 */
async function untilRunning(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await status()).running) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('音声補正が実行中になりませんでした');
}
async function fakeFfmpeg(body: string): Promise<void> {
  const script = join(root, 'fake-ffmpeg.sh');
  await writeFile(script, `#!/bin/sh\n${body}\n`); await chmod(script, 0o755);
  process.env.HARNESS_FFMPEG = script;
}

describe('POST /api/audio-fix', () => {
  it('未知の kind を拒否する', async () => {
    const response = await post({ assetId: asset.id, kind: 'sharpen' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('対応していない');
  });

  it('素材IDの形が不正なら拒否する（任意のパスを素材にできない）', async () => {
    for (const assetId of ['', '../../etc/passwd', '/etc/passwd', 42]) {
      const response = await post({ assetId, kind: 'denoise' });
      expect(response.status, String(assetId)).toBe(400);
    }
  });

  it('存在しない案件を拒否する', async () => {
    const response = await post({ assetId: asset.id, kind: 'denoise' }, 'missing-case');
    expect(response.status).toBe(404);
  });

  it('存在しない assetId を拒否する', async () => {
    const response = await post({ assetId: 'media-0123456789abcdef01234567', kind: 'denoise' });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain('見つかりません');
  });

  it('書き出し中は 409 で拒否し、素材を 1 つも足さない', async () => {
    vi.spyOn(sequenceExports, 'get').mockReturnValue({ phase: 'rendering' });
    const before = await registeredSequenceAssets(project);
    const response = await post({ assetId: asset.id, kind: 'denoise' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('書き出し');
    expect(await registeredSequenceAssets(project)).toHaveLength(before.length);
  });

  it('成功すると別の不変 asset を返し、原本のバイト列は変わらない', async () => {
    const originalPath = join(project, asset.file), originalBytes = await readFile(originalPath);
    const response = await post({ assetId: asset.id, kind: 'denoise' });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { asset: SequenceAsset; kind: string; from: string };
    expect(body.kind).toBe('denoise');
    expect(body.from).toBe(asset.id);
    expect(body.asset.id).not.toBe(asset.id);
    expect(body.asset.fingerprint).not.toBe(asset.fingerprint);
    expect(body.asset.origin).toEqual({ kind: 'audio-fix', from: asset.id, fix: 'denoise' });
    // 原本のファイルは 1 バイトも変わらない（fingerprint 照合が書き出しで効き続ける）。
    expect(await readFile(originalPath)).toEqual(originalBytes);
    // replace-audio-source は同じ番号の音声ストリームを要求する。
    expect(body.asset.streams.some((stream: MediaStream) => stream.kind === 'audio' && stream.index === 0)).toBe(true);
    const registry = await registeredSequenceAssets(project);
    expect(registry.some(item => item.id === asset.id)).toBe(true);
    expect(registry.find(item => item.id === body.asset.id)?.origin).toEqual(body.asset.origin);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('音量正規化も別 asset として登録する（2 パス）', async () => {
    const response = await post({ assetId: asset.id, kind: 'normalize' });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { asset: SequenceAsset };
    expect(body.asset.origin).toEqual({ kind: 'audio-fix', from: asset.id, fix: 'normalize' });
    expect(body.asset.id).not.toBe(asset.id);
  }, 30000);

  it('ffmpeg が失敗したら 500 を返し、asset を 1 つも登録しない', async () => {
    await fakeFfmpeg('exit 1');
    const before = await registeredSequenceAssets(project);
    const response = await post({ assetId: asset.id, kind: 'denoise' });
    expect(response.status).toBe(500);
    expect(await registeredSequenceAssets(project)).toHaveLength(before.length);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('同じ案件で 2 本同時に走らせない', async () => {
    await fakeFfmpeg('sleep 2\nexit 1');
    const first = post({ assetId: asset.id, kind: 'denoise' });
    await untilRunning();
    const second = await post({ assetId: asset.id, kind: 'normalize' });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain('実行中');
    expect((await first).status).toBe(500);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('待たずに 2 本同時に撃っても片方しか走らない（同 kind、TOCTOU）', async () => {
    const before = await registeredSequenceAssets(project);
    const [first, second] = await Promise.all([post({ assetId: asset.id, kind: 'denoise' }), post({ assetId: asset.id, kind: 'denoise' })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    // 勝者が登録した asset は 1 つだけ（系譜が分岐しない）。
    expect(await registeredSequenceAssets(project)).toHaveLength(before.length + 1);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('待たずに 2 本同時に撃っても片方しか走らない（kind 違い、TOCTOU）', async () => {
    const before = await registeredSequenceAssets(project);
    const [first, second] = await Promise.all([post({ assetId: asset.id, kind: 'denoise' }), post({ assetId: asset.id, kind: 'normalize' })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    // kind が違っても系譜が分岐しない: 登録された asset は 1 つだけ。
    expect(await registeredSequenceAssets(project)).toHaveLength(before.length + 1);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('後始末の途中で始まった次の補正のスロットを奪わない', async () => {
    // 1 本目: 応答の前にスロットを落とし、一時フォルダ掃除はゲートで止めておく。
    let release = () => {};
    gate.hold = new Promise<void>(resolve => { release = resolve; });
    const first = await post({ assetId: asset.id, kind: 'denoise' });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await status()).toEqual({ running: null });
    // 2 本目: 1 本目の後始末が終わる前に開始する。
    await fakeFfmpeg('sleep 3\nexit 1');
    const second = post({ assetId: asset.id, kind: 'normalize' });
    await untilRunning();
    expect((await status()).running).toBe('normalize');
    // 1 本目の外側 finally をここで走らせる。自分のものでないスロットは消してはいけない。
    release();
    for (let attempt = 0; attempt < 20 && (await status()).running; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    expect((await status()).running).toBe('normalize');
    expect((await post({ assetId: asset.id, kind: 'denoise' })).status).toBe(409);
    expect((await second).status).toBe(500);
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('実行中は /status が null に戻らず、完了後は null に戻る', async () => {
    await fakeFfmpeg('sleep 1\nexit 1');
    const first = post({ assetId: asset.id, kind: 'denoise' });
    await untilRunning();
    expect((await status()).running).toBe('denoise');
    await first;
    expect(await status()).toEqual({ running: null });
  }, 30000);

  it('メソッド違いと id 欠落を拒否する', async () => {
    expect((await fetch(`${origin}/api/audio-fix?id=case`)).status).toBe(405);
    expect((await fetch(`${origin}/api/audio-fix/status?id=case`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${origin}/api/audio-fix`, { method: 'POST' })).status).toBe(400);
  });
});
