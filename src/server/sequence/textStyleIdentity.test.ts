import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TELOP_PACK_ID, BUILTIN_TELOP_PACK_VERSION, PROJECT_TEMPLATE_PACK_ID, componentHash, textStyleCatalogKey } from '../telopPack/identity';
import { prepareNativeTextStyles, prepareNativeTextStyleAssets, backfillTextStyleCatalog } from './textStyles';
import { fixture } from '../../core/sequence/fixtures';
import { validateSequenceDocument } from '../../core/sequence/validate';

describe('componentHash', () => {
  it('同じ中身は同じ値・1 バイト違えば別の値になる', () => {
    expect(componentHash(new Uint8Array([1, 2, 3]))).toBe(componentHash(new Uint8Array([1, 2, 3])));
    expect(componentHash(new Uint8Array([1, 2, 3]))).not.toBe(componentHash(new Uint8Array([1, 2, 4])));
    expect(componentHash(new Uint8Array([1]))).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('同梱パックの識別', () => {
  it('凍結資産に packId・version・部品ハッシュが載る', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-telop-identity-'));
    try {
      const asset = await prepareNativeTextStyles(dir);
      expect(asset.textStyleCatalog).toMatchObject({ source: 'builtin', packId: BUILTIN_TELOP_PACK_ID, version: BUILTIN_TELOP_PACK_VERSION });
      expect(asset.textStyleCatalog!.componentHash).toMatch(/^[a-f0-9]{16}$/);
      expect(asset.textStyleCatalog!.entries.length).toBeGreaterThan(0);
      expect(textStyleCatalogKey(asset.textStyleCatalog!)).toBe(`${BUILTIN_TELOP_PACK_ID}@${BUILTIN_TELOP_PACK_VERSION}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);

  it('件数をコードに固定せず manifest から数える', async () => {
    const { TELOP_PACK } = await import('../telopPack/manifest');
    const dir = await mkdtemp(join(tmpdir(), 'harness-telop-count-'));
    try {
      const asset = await prepareNativeTextStyles(dir);
      expect(asset.textStyleCatalog!.entries).toHaveLength(TELOP_PACK.length);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);

  it('既に凍結資産を持つ案件は、パックが新しくなっても自動で置き換えない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-telop-freeze-'));
    try {
      const doc = fixture();
      const frozen = await prepareNativeTextStyles(dir);
      frozen.textStyleCatalog!.version = '0.0.1-old';
      frozen.textStyleCatalog!.componentHash = '0000000000000000';
      doc.assets.push(frozen);
      const assets = await prepareNativeTextStyleAssets(dir, doc);
      expect(assets[0]!.textStyleCatalog).toMatchObject({ version: '0.0.1-old', componentHash: '0000000000000000' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe('検証', () => {
  // T0b 以前（88d84987）に出荷済みのカタログ形式。3フィールドが無くても案件を開けなければならない。
  it('packId・version・componentHash の無い旧形式カタログは検証を通る', () => {
    const doc = fixture();
    doc.assets.push({ id: 'styles', kind: 'component', file: 'public/styles.mjs', name: 'スタイル', fingerprint: 'f',
      streams: [], textStyleCatalog: { source: 'builtin', entries: [{ id: 1, name: 'あ' }] } });
    expect(() => validateSequenceDocument(doc)).not.toThrow();
  });
  it('componentHash の形式が不正（16桁hexでない）なら拒否する', () => {
    const doc = fixture();
    doc.assets.push({ id: 'styles', kind: 'component', file: 'public/styles.mjs', name: 'スタイル', fingerprint: 'f', streams: [],
      textStyleCatalog: { source: 'installed', packId: 'pack.x', version: '1.0.0', componentHash: 'not-a-hash', entries: [{ id: 40, name: 'あ' }] } });
    expect(() => validateSequenceDocument(doc)).toThrow('文字スタイル');
  });
  it('source に installed を許す', () => {
    const doc = fixture();
    doc.assets.push({ id: 'styles', kind: 'component', file: 'public/styles.mjs', name: 'スタイル', fingerprint: 'f', streams: [],
      textStyleCatalog: { source: 'installed', packId: 'pack.x', version: '1.0.0', componentHash: 'abcdef0123456789', entries: [{ id: 40, name: 'あ' }] } });
    expect(() => validateSequenceDocument(doc)).not.toThrow();
  });
});

describe('backfillTextStyleCatalog: 旧形式カタログへの補完', () => {
  it('project の旧形式カタログに packId・version・componentHash を補う', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-telop-backfill-project-'));
    try {
      const frozen = await prepareNativeTextStyles(dir);
      const legacy = { ...frozen, textStyleCatalog: { source: 'project' as const, entries: frozen.textStyleCatalog!.entries } };
      const filled = await backfillTextStyleCatalog(dir, legacy);
      expect(filled.textStyleCatalog).toMatchObject({ source: 'project', packId: PROJECT_TEMPLATE_PACK_ID, version: legacy.fingerprint.slice(0, 8) });
      expect(filled.textStyleCatalog!.componentHash).toMatch(/^[a-f0-9]{16}$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);

  it('既に3フィールドが揃っているカタログには触らない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-telop-backfill-noop-'));
    try {
      const frozen = await prepareNativeTextStyles(dir);
      const filled = await backfillTextStyleCatalog(dir, frozen);
      expect(filled.textStyleCatalog).toEqual(frozen.textStyleCatalog);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);
});
