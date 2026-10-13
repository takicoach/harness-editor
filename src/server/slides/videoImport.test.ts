import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceAsset } from '../../core/sequence/model';
import { slidesFixture } from '../../core/slides/fixtures';
import { SequenceStore } from '../sequence/store';
import type { SlidesCapture } from './capture';
import { createSlidesProject } from './projects';
import { SlidesRenderInputs } from './renderInputs';
import { SlidesService } from './service';
import { SlidesStore } from './store';
import { SlidesImportLedger, SlidesVideoImports } from './videoImport';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'slides-import-')); roots.push(root);
  const slides = join(root, createSlidesProject(root, '講義').id), video = join(root, 'video-case'); mkdirSync(video);
  new SlidesStore(slides).save({ expectedSavedRevision: 0, executionId: 'seed', document: { ...slidesFixture(), revision: 1 } });
  new SequenceStore(video).save({ expectedSavedRevision: null, executionId: 'v', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
  const imported: Array<{ file: string; name: string }> = [];
  const capture: SlidesCapture = async (_target, count, shot, onPage) => { expect(shot).toEqual({ format: 'png' }); for (let i = 0; i < count; i++) await onPage(i, Buffer.from(`png-${i}`)); };
  const importAsset = async (_directory: string, file: string, name: string): Promise<SequenceAsset> => {
    imported.push({ file, name }); const fingerprint = String(imported.length).repeat(64).slice(0, 64);
    return { id: `asset-${imported.length}`, kind: 'image', name, file: `.harness/assets/${fingerprint}.png`, fingerprint, streams: [] };
  };
  const service = new SlidesService();
  return { root, slides, video, service, imported, imports: new SlidesVideoImports(capture, new SlidesRenderInputs(), importAsset) };
}
const start = (ctx: ReturnType<typeof setup>, pageIds: string[], videoProjectId = 'video-case') => ctx.imports.start({ root: ctx.root, slidesDirectory: ctx.slides, slidesProjectId: '講義',
  origin: 'http://127.0.0.1:1', state: ctx.service.open(ctx.slides), pageIds, videoProjectId, signal: new AbortController().signal });

describe('SlidesVideoImports', () => {
  it('選んだページを確定版の画像として動画案件の素材に取り込み、元の文書 ID・ページ ID・版を記録する', async () => {
    const ctx = setup(), record = await start(ctx, ['page-2']);
    expect(record).toMatchObject({ slides: { projectId: '講義', documentId: 'slides-1', revision: 1 }, placed: null,
      pages: [{ pageId: 'page-2', number: 2, assetId: 'asset-1', name: '講義_002.png' }] });
    expect(ctx.imported.map(item => item.name)).toEqual(['講義_002.png']);
    expect(new SlidesImportLedger(ctx.video).list()).toEqual([record]);
    const placed = new SlidesImportLedger(ctx.video).markPlaced(record.importId, { at: '2026-10-04T00:00:00.000Z', videoRevision: 2, clipIds: ['c1'] });
    expect(placed.placed).toEqual({ at: '2026-10-04T00:00:00.000Z', videoRevision: 2, clipIds: ['c1'] });
    expect(() => new SlidesImportLedger(ctx.video).markPlaced(record.importId, { at: 'x', videoRevision: 3, clipIds: [] })).toThrow('この取り込みはもう置いてあります');
  });
  it('取り込みの記録が壊れていたら（読めない・大きすぎる・中身が不正）改名して残し、作り直す', async () => {
    const ctx = setup(), ledger = new SlidesImportLedger(ctx.video), folder = join(ctx.video, '.harness'); mkdirSync(folder, { recursive: true });
    const valid = { importId: 'imp-00000000-0000-4000-8000-000000000000', createdAt: '2026-10-06T00:00:00.000Z', slides: { projectId: '講義', documentId: 'slides-1', revision: 1 },
      pages: [{ pageId: 'page-1', number: 1, assetId: 'asset-1', fingerprint: 'a'.repeat(64), contentHash: 'h', name: '講義_001.png' }], placed: null };
    const broken = [
      '{ 壊れた JSON',
      JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: [{ ...valid, pages: 'ページではない' }] }),
      JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: [{ ...valid, importId: '../../外' }] }),
      JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: [{ ...valid, placed: { at: 'x', videoRevision: -1, clipIds: [] } }] }),
      JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: [valid], padding: 'x'.repeat(9 * 1024 * 1024) }),
    ];
    for (const [index, text] of broken.entries()) {
      writeFileSync(ledger.file, text);
      expect(ledger.list(), `${index}`).toEqual([]);
      const kept = readdirSync(folder).filter(name => name.startsWith('slides-imports.v1.json.broken-'));
      expect(kept, `${index}`).toHaveLength(index + 1);
    }
    // 作り直した記録には、そのまま足せる。
    const record = await start(ctx, ['page-1']);
    expect(new SlidesImportLedger(ctx.video).list()).toEqual([record]);
    expect(JSON.parse(readFileSync(ledger.file, 'utf8')).imports).toHaveLength(1);
    writeFileSync(ledger.file, JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: [valid] }));
    expect(ledger.list()).toEqual([valid]);
  });
  it('取り込み中は重い処理の枠に数える（activeCount）', async () => {
    const ctx = setup();
    let finish = () => {}, markStarted = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const capture: SlidesCapture = async (_target, count, _shot, onPage) => {
      await new Promise<void>(resolve => { finish = resolve; markStarted(); });
      for (let i = 0; i < count; i++) await onPage(i, Buffer.from(`png-${i}`));
    };
    const imports = new SlidesVideoImports(capture, new SlidesRenderInputs(), async (_directory, _file, name) => ({ id: 'asset-x', kind: 'image', name,
      file: `.harness/assets/${'b'.repeat(64)}.png`, fingerprint: 'b'.repeat(64), streams: [] }));
    expect(imports.activeCount()).toBe(0);
    const pending = imports.start({ root: ctx.root, slidesDirectory: ctx.slides, slidesProjectId: '講義', origin: 'http://127.0.0.1:1', state: ctx.service.open(ctx.slides),
      pageIds: ['page-1'], videoProjectId: 'video-case', signal: new AbortController().signal });
    await started;
    expect(imports.activeCount()).toBe(1);
    finish(); await pending;
    expect(imports.activeCount()).toBe(0);
  });
  it('未保存の直しがあれば断る。知らないページ・新形式でない動画・スライド自身へは取り込まない', async () => {
    const ctx = setup(), state = ctx.service.open(ctx.slides);
    await expect(start(ctx, ['nope'])).rejects.toThrow('選んだページが見つかりません');
    await expect(start(ctx, ['page-1'], '講義')).rejects.toThrow('新形式の動画案件だけに取り込めます');
    mkdirSync(join(ctx.root, 'empty'));
    await expect(start(ctx, ['page-1'], 'empty')).rejects.toThrow('新形式の動画案件だけに取り込めます');
    ctx.service.execute(ctx.slides, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'dirty', command: { type: 'set-notes', pageId: 'page-1', notes: '未保存' } });
    await expect(start(ctx, ['page-1'])).rejects.toThrow('保存してから取り込んでください');
  });
});
