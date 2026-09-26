import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyPreviewContexts } from './legacyPreviewContexts';
import type { LegacyPreviewCatalog } from '../../core/sequence/legacyPreview';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./migration', () => ({ prepareLegacyPreviewCatalog: (...args: unknown[]) => prepare(...args) }));
const catalog: LegacyPreviewCatalog = { references: { main: 'main.mp4', telop: false, image: false, images: [], videoInserts: [], bgm: [], se: [] },
  sourceFingerprint: 'source', assets: [], bindings: { main: 'main', images: {}, videoInserts: {}, bgm: {}, se: {} }, staticFiles: {} };
const roots: string[] = [];
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), 'harness-preview-lease-')); roots.push(root); const directory = join(root, 'case'); await mkdir(directory); prepare.mockResolvedValue(catalog); return { root, directory }; };
afterEach(async () => { vi.useRealTimers(); prepare.mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('rejects a different directory reused at the same pathname and cancels its old lease', async () => {
  const { root, directory } = await fixture(), contexts = new LegacyPreviewContexts();
  const context = await contexts.create(directory, catalog.references);
  await rename(directory, join(root, 'original')); await mkdir(directory);
  expect(() => contexts.get(directory, context.token)).toThrow(/変更/); expect(context.signal.aborted).toBe(true);
});
it('maps deletion to a local 404 message and cancels the old lease', async () => {
  const { directory } = await fixture(), contexts = new LegacyPreviewContexts();
  const context = await contexts.create(directory, catalog.references); await rm(directory, { recursive: true });
  expect(() => contexts.get(directory, context.token)).toThrow(expect.objectContaining({ status: 404, message: '案件フォルダーが変更されています' }));
  expect(context.signal.aborted).toBe(true);
});
it('revokes consumers on DELETE and timer expiry without requiring another GET', async () => {
  const { directory } = await fixture(); vi.useFakeTimers();
  const contexts = new LegacyPreviewContexts(Date.now, 1000), first = await contexts.create(directory, catalog.references), second = await contexts.create(directory, catalog.references);
  contexts.release(directory, first.token); expect(first.signal.aborted).toBe(true); expect(second.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1001); expect(second.signal.aborted).toBe(true); expect(() => contexts.get(directory, second.token)).toThrow(/失効/);
});
it('rejects root replacement during preparation and returns the reserved capacity', async () => {
  const { root, directory } = await fixture(), contexts = new LegacyPreviewContexts(Date.now, 60000, 1);
  let finish!: (catalog: LegacyPreviewCatalog) => void; prepare.mockReturnValueOnce(new Promise<LegacyPreviewCatalog>(resolve => { finish = resolve; }));
  const pending = contexts.create(directory, catalog.references); const rejected = expect(pending).rejects.toThrow(/フォルダーが変更/);
  await expect(contexts.create(directory, catalog.references)).rejects.toThrow(/多すぎ/);
  await rename(directory, join(root, 'original')); await mkdir(directory); finish(catalog); await rejected;
  const replacement = await contexts.create(directory, catalog.references); expect(contexts.get(directory, replacement.token)).toBe(replacement); contexts.release(directory, replacement.token);
});
