import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAssetOrigin, registeredSequenceAssets } from './assets';
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
