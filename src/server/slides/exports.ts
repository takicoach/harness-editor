import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import { sequenceContentBytes } from '../../core/sequence/validate';
import { slidePageToSequence } from '../../core/slides/pageView';
import { HttpError } from '../http';
import { verifiedSequenceAssetPath } from '../sequence/assets';
import { captureSlides, type SlidesCapture } from './capture';
import { renderSlidesPdf, type SlidesPdfRenderer } from './pdf';
import { slidesRenderInputs, type SlidesRenderInputs } from './renderInputs';
import { slidesService, type SlidesEvent, type SlidesSessionState } from './service';

export const SLIDES_EXPORT_FOLDER = '書き出し';
export const SLIDES_PDF_JPEG_QUALITY = 90;
export type SlidesExportFormat = 'png' | 'pdf' | 'pdf-notes';
export interface SlidesExportRequest { sessionId: string; expectedRevision: number; executionId: string; format: SlidesExportFormat }
export type SlidesExportPhase = 'checking' | 'rendering' | 'composing' | 'complete' | 'failed' | 'cancelled';
export interface SlidesExportStatus {
  executionId: string; jobId: string; format: SlidesExportFormat; revision: number; contentHash: string; pages: number; done: number; phase: SlidesExportPhase;
  files?: string[]; error?: string;
}
interface Job { key: string; directory: string; projectId: string; origin: string; documents: SequenceDocument[]; notes: string[]; status: SlidesExportStatus; controller: AbortController;
  completion: Promise<void>; /** 書き出し先への公開を始めた（ここからは取り消せない）。 */ publishing: boolean }
const running = (job: Job) => job.status.phase === 'checking' || job.status.phase === 'rendering' || job.status.phase === 'composing';
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanName = (value: string) => value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
/** 書き出しの名前の元（スライド名。80 字まで）。 */
export function slidesFileBase(projectName: string): string { return Array.from(cleanName(projectName) || 'スライド').slice(0, 80).join(''); }
export function slidesPngName(base: string, index: number): string { return `${base}_${String(index + 1).padStart(3, '0')}.png`; }
export function slidesPdfName(base: string, notes: boolean): string { return notes ? `${base}_メモ付き.pdf` : `${base}.pdf`; }

/** 書き出し先がリンクで案件の外を向いていないことを確かめて用意する。 */
async function prepareExportFolder(folder: string): Promise<void> {
  const existing = await lstat(folder).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error('書き出し先のフォルダーが通常のフォルダーではありません');
  await mkdir(folder, { recursive: true });
  if ((await realpath(folder)) !== join(await realpath(dirname(folder)), basename(folder))) throw new Error('書き出し先のフォルダーが案件の外を指しています');
}
/** 一時ファイル → rename（同じ名前は置き換え。途中で失敗しても前のファイルは壊さない）。 */
export async function publishSlidesFile(folder: string, name: string, bytes: Buffer): Promise<void> {
  await prepareExportFolder(folder);
  const temporary = join(folder, `.slides-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(folder, name));
  } finally { await unlink(temporary).catch(() => undefined); }
}
/** 一式（PNG）: 先に全部を書き出し先の中の隠しフォルダーへ書きそろえ（fsync）、そろってから名前を付け替えて公開する。
 * 書いている途中の失敗・取消では何も公開しない（新旧が混ざらない）。onPublishing の後は取り消せない。 */
async function publishSlidesSet(folder: string, files: ReadonlyArray<{ name: string; bytes: Buffer }>, signal: AbortSignal, onPublishing: () => void): Promise<void> {
  await prepareExportFolder(folder);
  const staging = join(folder, `.slides-set-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const file of files) {
      signal.throwIfAborted();
      const handle = await open(join(staging, file.name), 'wx', 0o644);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    signal.throwIfAborted();
    onPublishing();
    for (const file of files) await rename(join(staging, file.name), join(folder, file.name));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
/** PNG 一式の古い番号（今のページ数を超えた分）だけを消す。ほかのファイルは触らない。 */
async function removeStalePngs(folder: string, base: string, count: number): Promise<void> {
  const pattern = new RegExp(`^${escapeRegExp(base)}_(\\d{3})\\.png$`);
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const match = pattern.exec(name);
    if (match && Number(match[1]) > count) await unlink(join(folder, name)).catch(() => undefined);
  }
}

/** 入力の固定（版＋内容の指紋）・素材の確認・案件ごとに同時 1 件・取消と後始末・一時ファイル → 確定・要求 ID での照会。 */
export class SlidesExports {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly capture: SlidesCapture = captureSlides, private readonly pdf: SlidesPdfRenderer = renderSlidesPdf,
    private readonly inputs: SlidesRenderInputs = slidesRenderInputs, private readonly notify: (directory: string, event: SlidesEvent) => void = () => undefined) {}
  start(input: { directory: string; projectId: string; origin: string; request: SlidesExportRequest; state: () => SlidesSessionState }): SlidesExportStatus {
    const root = realpathSync(input.directory), request = input.request, key = `${root}\0${request.executionId}`, existing = this.jobs.get(key);
    if (existing) {
      if (existing.status.format !== request.format || existing.status.revision !== request.expectedRevision) throw new HttpError(409, '同じ書き出しIDに異なる要求があります');
      return { ...existing.status };
    }
    if ([...this.jobs.values()].some(job => job.directory === root && running(job))) throw new HttpError(409, '別の書き出しを実行中です。終わってからもう一度押してください');
    const state = input.state();
    if (state.sessionId !== request.sessionId || state.document.revision !== request.expectedRevision) throw new HttpError(409, '編集内容が変わりました。もう一度書き出してください');
    if (!state.document.pages.length) throw new HttpError(400, 'ページがありません');
    const documents = state.document.pages.map(page => slidePageToSequence(state.document, page.id));
    const status: SlidesExportStatus = { executionId: request.executionId, jobId: `slides-${randomUUID()}`, format: request.format, revision: state.document.revision,
      contentHash: createHash('sha256').update(documents.map(sequenceContentBytes).join('\n')).digest('hex'), pages: documents.length, done: 0, phase: 'checking' };
    const job: Job = { key, directory: root, projectId: input.projectId, origin: input.origin, documents, notes: state.document.pages.map(page => page.notes), status,
      controller: new AbortController(), completion: Promise.resolve(), publishing: false };
    this.jobs.set(key, job);
    this.trim();
    job.completion = this.run(job);
    return { ...status };
  }
  status(directory: string, executionId: string): SlidesExportStatus | undefined {
    const job = this.jobs.get(`${realpathSync(directory)}\0${executionId}`);
    return job ? { ...job.status } : undefined;
  }
  async wait(directory: string, executionId: string): Promise<SlidesExportStatus> { const job = this.find(directory, executionId); await job.completion; return { ...job.status }; }
  /** 取消は公開の前まで。公開を始めた後は、途中で止めると新旧が混ざるので取り消さない（正直に断る）。 */
  cancel(directory: string, executionId: string): SlidesExportStatus {
    const job = this.find(directory, executionId);
    if (job.publishing && running(job)) throw new HttpError(409, '書き出し先へ保存している最中のため、取り消せません。終わるまでお待ちください');
    job.controller.abort();
    return { ...job.status };
  }
  /** 重い処理の枠（heavyJobGate）に数える、実行中の書き出しの数。 */
  activeCount(): number { return [...this.jobs.values()].filter(running).length; }
  outputFile(directory: string, executionId: string, index: number): string {
    const job = this.find(directory, executionId), file = job.status.files?.[index];
    if (job.status.phase !== 'complete' || !file) throw new HttpError(409, '書き出しはまだ終わっていません');
    return join(job.directory, file);
  }
  killAll(): void { for (const job of this.jobs.values()) job.controller.abort(); }
  /** busy 照会用（jobRegistries）。 */
  get(projectId: string, directory?: string): { phase: string } | undefined {
    const root = directory ? realpathSync(directory) : undefined;
    const active = [...this.jobs.values()].find(job => running(job) && (root ? job.directory === root : job.projectId === projectId));
    return active ? { phase: active.status.phase } : undefined;
  }
  private find(directory: string, executionId: string): Job {
    const job = this.jobs.get(`${realpathSync(directory)}\0${executionId}`);
    if (!job) throw new HttpError(404, '書き出しの記録がありません');
    return job;
  }
  private trim(): void {
    while (this.jobs.size > 50) {
      const oldest = [...this.jobs.values()].find(job => !running(job));
      if (!oldest) return;
      this.jobs.delete(oldest.key);
    }
  }
  private emit(job: Job): void { this.notify(job.directory, { type: 'export', executionId: job.status.executionId, phase: job.status.phase }); }
  private async run(job: Job): Promise<void> {
    await Promise.resolve();
    const { status, controller } = job, signal = controller.signal;
    try {
      this.emit(job);
      for (const document of job.documents) {
        const enabled = new Set(document.tracks.filter(track => track.enabled).map(track => track.id));
        for (const clip of document.clips) {
          if (!enabled.has(clip.trackId) || clip.content.kind !== 'image') continue;
          const assetId = clip.content.assetId, asset = document.assets.find(item => item.id === assetId);
          try { if (!asset) throw new Error('素材がありません'); await verifiedSequenceAssetPath(job.directory, asset, signal); }
          catch { signal.throwIfAborted(); throw new Error(`画像が見つかりません（${asset?.name ?? assetId}）`); }
        }
      }
      signal.throwIfAborted();
      status.phase = 'rendering'; this.emit(job);
      const images: Buffer[] = [], release = this.inputs.register(job.directory, status.jobId, job.documents);
      try {
        await this.capture({ origin: job.origin, projectId: job.projectId, jobId: status.jobId, signal }, job.documents.length,
          status.format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: SLIDES_PDF_JPEG_QUALITY },
          (index, bytes) => { images[index] = bytes; status.done = index + 1; this.emit(job); });
      } finally { release(); }
      signal.throwIfAborted();
      const pages = job.documents.map((_, index) => images[index]);
      if (pages.some(bytes => !bytes)) throw new Error('撮れなかったページがあります。もう一度書き出してください');
      const shots = pages as Buffer[], folder = join(job.directory, SLIDES_EXPORT_FOLDER), base = slidesFileBase(basename(job.directory));
      // 公開を始めたら取り消せない（cancel が断る）。始まりを知らせる。
      const publishing = () => { job.publishing = true; this.emit(job); };
      status.phase = 'composing'; this.emit(job);
      if (status.format === 'png') {
        const files = shots.map((bytes, index) => ({ name: slidesPngName(base, index), bytes }));
        await publishSlidesSet(folder, files, signal, publishing);
        await removeStalePngs(folder, base, files.length);
        status.files = files.map(file => `${SLIDES_EXPORT_FOLDER}/${file.name}`);
      } else {
        const withNotes = status.format === 'pdf-notes', name = slidesPdfName(base, withNotes);
        const pdf = await this.pdf({ origin: job.origin, signal, images: shots, notes: withNotes ? job.notes : null });
        signal.throwIfAborted();
        publishing();
        await publishSlidesFile(folder, name, pdf);
        status.files = [`${SLIDES_EXPORT_FOLDER}/${name}`];
      }
      status.phase = 'complete';
    } catch (error) {
      // 公開を始めた後の失敗は取消ではない（取消は公開の前までしか効かない）。
      status.phase = signal.aborted && !job.publishing ? 'cancelled' : 'failed';
      if (status.phase === 'failed') status.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    } finally { this.emit(job); }
  }
}
export const slidesExports = new SlidesExports(captureSlides, renderSlidesPdf, slidesRenderInputs, (directory, event) => slidesService.notify(directory, event));
