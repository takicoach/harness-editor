import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { SequenceAsset } from '../../core/sequence/model';
import { SLIDES_MAX_PAGES } from '../../core/slides/model';
import { slidePageToSequence } from '../../core/slides/pageView';
import type { SlideImportRecord } from '../../core/slides/videoImport';
import { HttpError } from '../http';
import { resolveProjectDir } from '../projectRoot';
import { importSequenceAsset } from '../sequence/assets';
import { SequenceStore } from '../sequence/store';
import { captureSlides, type SlidesCapture } from './capture';
import { slidesFileBase, slidesPngName } from './exports';
import { slidesRenderInputs, type SlidesRenderInputs } from './renderInputs';
import { slidesPageHash, type SlidesSessionState } from './service';

export const SLIDES_IMPORT_LEDGER = 'slides-imports.v1.json';
/** 記録の大きさの上限（50 件 × 120 ページでも十分に収まる）。 */
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const IMPORT_ID = /^imp-[0-9a-f-]{36}$/;
const isText = (value: unknown, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isCount = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isImportPage = (value: unknown) => isObject(value) && isText(value.pageId, 128) && isCount(value.number, 1) && isText(value.assetId, 128)
  && isText(value.fingerprint, 128) && isText(value.contentHash, 128) && isText(value.name, 512);
/** 記録 1 件の中身の検証（壊れた・書き換えられた記録をそのまま使わない）。 */
function isImportRecord(value: unknown): value is SlideImportRecord {
  if (!isObject(value) || typeof value.importId !== 'string' || !IMPORT_ID.test(value.importId) || !isText(value.createdAt, 64)) return false;
  const { slides, pages, placed } = value;
  return isObject(slides) && isText(slides.projectId) && isText(slides.documentId, 128) && isCount(slides.revision)
    && Array.isArray(pages) && pages.length > 0 && pages.length <= SLIDES_MAX_PAGES && pages.every(isImportPage)
    && (placed === null || (isObject(placed) && isText(placed.at, 64) && isCount(placed.videoRevision) && Array.isArray(placed.clipIds)
      && placed.clipIds.length <= SLIDES_MAX_PAGES && placed.clipIds.every(clipId => isText(clipId, 128))));
}
/** 動画案件側の記録（<動画>/.harness/slides-imports.v1.json）。動画の保存（project.v2.json）とは別のファイル。新しい 50 件を残す。 */
export class SlidesImportLedger {
  readonly file: string;
  constructor(videoDirectory: string) { this.file = join(realpathSync(videoDirectory), '.harness', SLIDES_IMPORT_LEDGER); }
  list(): SlideImportRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const info = lstatSync(this.file);
      if (!info.isFile() || info.size > LEDGER_MAX_BYTES) throw new Error('通常のファイルでないか、大きすぎます');
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { format?: unknown; imports?: unknown } | null;
      if (!value || value.format !== 'harness-slides-imports' || !Array.isArray(value.imports) || !value.imports.every(isImportRecord)) throw new Error('形式が不正です');
      return value.imports as SlideImportRecord[];
    } catch {
      // 壊れた記録は消さずに改名して残し、新しく始める（動画の文書と素材は無傷）。
      try { renameSync(this.file, `${this.file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`); }
      catch { throw new HttpError(500, 'スライドの取り込みの記録を読めません'); }
      return [];
    }
  }
  private write(imports: SlideImportRecord[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ format: 'harness-slides-imports', version: 1, imports: imports.slice(-50) }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, this.file); } catch (error) { try { unlinkSync(temporary); } catch { /* 無視 */ } throw error; }
  }
  add(record: SlideImportRecord): void { this.write([...this.list(), record]); }
  find(importId: string): SlideImportRecord {
    const record = this.list().find(item => item.importId === importId);
    if (!record) throw new HttpError(404, '取り込みの記録がありません');
    return record;
  }
  /** 動画の文書に残る置いたクリップ（liveClipIds が返す ID）と記録を照合し、記録の書き込みに失敗していた置き場所を記録に直す。 */
  reconcile(liveClipIds: (record: SlideImportRecord) => string[], videoRevision: number): SlideImportRecord[] {
    const imports = this.list();
    let changed = false;
    for (const record of imports) {
      const clipIds = liveClipIds(record);
      if (!clipIds.length || (record.placed && clipIds.every(clipId => record.placed!.clipIds.includes(clipId)))) continue;
      record.placed = { at: new Date().toISOString(), videoRevision, clipIds };
      changed = true;
    }
    // 直した記録を書けなくても、照合した結果は返す（次の読み込みでまた直す）。
    if (changed) {
      try { this.write(imports); }
      catch (error) { console.warn('[sme] スライドの取り込みの記録を直せませんでした:', error instanceof Error ? error.message : error); }
    }
    return imports;
  }
  /** 置いた記録。isLive は「記録のクリップがまだ動画にあるか」（元に戻して消えていれば false＝置き直せる）。 */
  markPlaced(importId: string, placed: NonNullable<SlideImportRecord['placed']>, isLive: (placed: NonNullable<SlideImportRecord['placed']>) => boolean = () => true): SlideImportRecord {
    const imports = this.list(), record = imports.find(item => item.importId === importId);
    if (!record) throw new HttpError(404, '取り込みの記録がありません');
    if (record.placed && isLive(record.placed)) throw new HttpError(409, 'この取り込みはもう置いてあります');
    record.placed = placed;
    this.write(imports);
    return record;
  }
}

type ImportAsset = (directory: string, file: string, name: string, signal?: AbortSignal) => Promise<SequenceAsset>;
/** スライドの確定版のページを PNG に描き、動画案件の素材として取り込む（上書きしない新しい素材）。 */
export class SlidesVideoImports {
  private active = 0;
  constructor(private readonly capture: SlidesCapture = captureSlides, private readonly inputs: SlidesRenderInputs = slidesRenderInputs,
    private readonly importAsset: ImportAsset = importSequenceAsset) {}
  /** 重い処理の枠（heavyJobGate）に数える、撮影・取り込み中の数。 */
  activeCount(): number { return this.active; }
  async start(input: { root: string; slidesDirectory: string; slidesProjectId: string; origin: string; state: SlidesSessionState; pageIds: readonly string[];
    videoProjectId: string; signal: AbortSignal }): Promise<SlideImportRecord> {
    const { state } = input, document = state.document;
    if (!input.pageIds.length) throw new HttpError(400, '取り込むページを選んでください');
    const pages = document.pages.filter(page => input.pageIds.includes(page.id));
    if (pages.length !== new Set(input.pageIds).size) throw new HttpError(404, '選んだページが見つかりません');
    let videoDirectory: string;
    try { videoDirectory = resolveProjectDir(input.root, input.videoProjectId); } catch { throw new HttpError(400, '新形式の動画案件だけに取り込めます'); }
    if (resolve(input.root) === resolve(videoDirectory) || !existsSync(videoDirectory) || realpathSync(videoDirectory) === realpathSync(input.slidesDirectory)
      || !new SequenceStore(videoDirectory).load()) throw new HttpError(400, '新形式の動画案件だけに取り込めます');
    if (state.dirty) throw new HttpError(409, '保存してから取り込んでください（取り込むのは保存した確定版です）');
    const jobId = `slides-import-${randomUUID()}`, release = this.inputs.register(input.slidesDirectory, jobId, pages.map(page => slidePageToSequence(document, page.id)));
    this.active++;
    let work: string | undefined;
    try {
      work = await mkdtemp(join(tmpdir(), 'harness-slides-import-'));
      const directory = work, base = slidesFileBase(basename(input.slidesDirectory));
      const files: string[] = [];
      await this.capture({ origin: input.origin, projectId: input.slidesProjectId, jobId, signal: input.signal }, pages.length, { format: 'png' }, async (index, bytes) => {
        const file = join(directory, `${index}.png`); await writeFile(file, bytes); files[index] = file;
      });
      const record: SlideImportRecord = { importId: `imp-${randomUUID()}`, createdAt: new Date().toISOString(),
        slides: { projectId: input.slidesProjectId, documentId: document.id, revision: document.revision }, pages: [], placed: null };
      for (const [index, page] of pages.entries()) {
        const number = document.pages.indexOf(page) + 1, name = slidesPngName(base, number - 1);
        const asset = await this.importAsset(videoDirectory, files[index]!, name, input.signal);
        record.pages.push({ pageId: page.id, number, assetId: asset.id, fingerprint: asset.fingerprint, contentHash: state.pageHashes[page.id] ?? slidesPageHash(document, page.id), name });
      }
      new SlidesImportLedger(videoDirectory).add(record);
      return record;
    } finally { this.active--; release(); if (work) await rm(work, { recursive: true, force: true }); }
  }
}
export const slidesVideoImports = new SlidesVideoImports();
