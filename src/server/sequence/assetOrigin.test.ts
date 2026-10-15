import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAssetOrigin, registeredSequenceAssets } from './assets';
import { openSequenceReference, reconnectSequenceReference, registerSequenceReference, registeredSequenceReferences } from './references';
import { rational as r } from '../../core/sequence/time';
import type { SequenceAsset } from '../../core/sequence/model';

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-asset-origin-'));
  await mkdir(join(root, '.harness/assets'), { recursive: true });
  const bytes = Buffer.from('fixed-audio'), fingerprint = createHash('sha256').update(bytes).digest('hex');
  const file = `.harness/assets/${fingerprint}.wav`;
  await writeFile(join(root, file), bytes);
  const asset: SequenceAsset = { id: 'source-denoised', kind: 'media', file, name: '映像（ノイズ除去）', fingerprint,
    streams: [{ index: 0, kind: 'audio', codec: 'aac', duration: r(60), sampleRate: 48000, channels: 2 }] };
  await writeFile(join(root, file) + '.json', JSON.stringify({ format: 'harness-asset', version: 1, asset }) + '\n');
  return root;
}

describe('registerAssetOrigin', () => {
  it('台帳の登録情報に由来だけを書き足す', async () => {
    const root = await project();
    const updated = await registerAssetOrigin(root, 'source-denoised', { kind: 'audio-fix', from: 'source', fix: 'denoise' });
    expect(updated.origin).toEqual({ kind: 'audio-fix', from: 'source', fix: 'denoise' });
    expect(updated.fingerprint).toBe((await registeredSequenceAssets(root))[0]!.fingerprint);
    expect((await registeredSequenceAssets(root))[0]!.origin).toEqual({ kind: 'audio-fix', from: 'source', fix: 'denoise' });
  });
  it('台帳に無い素材は拒否する', async () => {
    await expect(registerAssetOrigin(await project(), 'missing', { kind: 'audio-fix', from: 'source', fix: 'normalize' }))
      .rejects.toThrow('由来を記録する素材が見つかりません');
  });
});

/** 1 秒弱の無音に近い 8kHz モノラル WAV（references.test.ts と同じ形）。 */
function wav(): Buffer {
  const b = Buffer.alloc(44 + 1600);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(1600, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(i % 100, i);
  return b;
}
const owned: string[] = [];
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('registerAssetOrigin（リンク素材）', () => {
  // 「＋ 効果音を追加」「＋ BGM を追加」はファイルをリンクで取り込み、取り込んだ役割を由来に残す。
  // リンク素材の登録情報は参照台帳（.harness/references/<指紋>.<拡張子>.json）にあり、管理素材の台帳の形で上書きすると読めなくなる。
  it('リンク素材に役割を付けても参照台帳が読め、素材を開け、つなぎ直しても役割が残る', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-asset-origin-reference-')); owned.push(root);
    const project = join(root, 'project'), source = join(root, 'effect.wav');
    await mkdir(project); await writeFile(source, wav());
    const asset = await registerSequenceReference(project, source, 'effect.wav');
    const ledger = join(project, asset.file) + '.json', before = JSON.parse(await readFile(ledger, 'utf8'));

    const updated = await registerAssetOrigin(project, asset.id, { kind: 'import', role: 'effect' });
    expect(updated).toEqual({ ...asset, origin: { kind: 'import', role: 'effect' } });
    // 台帳は参照台帳の形のまま（接続先・世代・大きさは変えない）。
    const after = JSON.parse(await readFile(ledger, 'utf8'));
    expect(after).toEqual({ ...before, asset: { ...before.asset, origin: { kind: 'import', role: 'effect' } } });
    expect(await registeredSequenceReferences(project)).toEqual([updated]);
    expect((await registeredSequenceAssets(project)).find(item => item.id === asset.id)?.origin).toEqual({ kind: 'import', role: 'effect' });
    const lease = await openSequenceReference(project, updated); await lease.verify(); await lease.close();

    // 同じ役割をもう一度付けても台帳は書き換えない。
    const unchanged = await readFile(ledger, 'utf8');
    await registerAssetOrigin(project, asset.id, { kind: 'import', role: 'effect' });
    expect(await readFile(ledger, 'utf8')).toBe(unchanged);

    // 素材を動かしてつなぎ直しても、役割は台帳に残る。
    const moved = join(root, 'moved.wav'); await rename(source, moved);
    await reconnectSequenceReference(project, updated, moved);
    expect((await registeredSequenceReferences(project))[0]?.origin).toEqual({ kind: 'import', role: 'effect' });
  });
});
