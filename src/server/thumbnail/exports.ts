import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import { sequenceContentBytes } from '../../core/sequence/validate';
import { findPage, thumbnailMainPageId } from '../../core/thumbnail/model';
import { pageToSequence } from '../../core/thumbnail/pageToSequence';
import { HttpError } from '../http';
import { verifiedSequenceAssetPath } from '../sequence/assets';
import { captureThumbnail, type ThumbnailCapture } from './capture';
import { THUMBNAIL_EXPORT_FOLDER, thumbnailFileBase } from './cover';
import { notifyProjectStatusChanged } from '../projectsWatch';
import { thumbnailRenderInputs, type ThumbnailRenderInputs } from './renderInputs';
import { thumbnailService, type ThumbnailEvent, type ThumbnailSessionState } from './service';

export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
export const THUMBNAIL_JPEG_QUALITIES = [90, 85, 80, 75, 70, 65, 60, 55, 50] as const;
export interface ThumbnailExportRequest { sessionId: string; expectedRevision: number; executionId: string; pageId: string; format: 'png' | 'jpeg' }
export type ThumbnailExportPhase = 'checking' | 'rendering' | 'complete' | 'failed' | 'cancelled';
export interface ThumbnailExportStatus {
  /** main はメインの案か（書き出しの名前が <案件名> サムネ になる）。開始時の文書で固定する。 */
  executionId: string; jobId: string; pageId: string; pageName: string; main: boolean; revision: number; contentHash: string; format: 'png' | 'jpeg'; phase: ThumbnailExportPhase;
  fileName?: string; bytes?: number; quality?: number; overLimit?: boolean; error?: string;
}
interface Job { key: string; directory: string; projectId: string; origin: string; document: SequenceDocument; status: ThumbnailExportStatus; controller: AbortController; completion: Promise<void> }
const running = (job: Job) => job.status.phase === 'checking' || job.status.phase === 'rendering';

/**
 * 一時ファイルを書いてから rename で置き換える（同じ名前は上書きし、案ごとに最新の 1 枚を残す）。
 * 途中で失敗しても前のファイルは壊さない。公開に成功した後で、拡張子だけ違う同名の古いファイル（png↔jpg）を消す。
 */
export async function publishThumbnail(folder: string, base: string, extension: '.png' | '.jpg', bytes: Buffer): Promise<string> {
  // 書き出し先がリンクで案件の外へ向いていないことを確かめる（保存側 .harness と同じ方針）。
  const existing = await lstat(folder).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error('書き出し先のフォルダーが通常のフォルダーではありません');
  await mkdir(folder, { recursive: true });
  if ((await realpath(folder)) !== join(await realpath(dirname(folder)), basename(folder)))
    throw new Error('書き出し先のフォルダーが案件の外を指しています');
  const name = `${base}${extension}`, stale = `${base}${extension === '.png' ? '.jpg' : '.png'}`;
  const temporary = join(folder, `.thumbnail-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // rename は置き換え先がリンクでも辿らず、名前ごと差し替える（案件の外のファイルを書き換えない）。
    // 置き換え先がフォルダーなら消さずに止め、利用者に分かる理由にする（パスを含む英語のままにしない）。
    await rename(temporary, join(folder, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EISDIR')
        throw new Error(`書き出し先に同じ名前のフォルダーがあります（${name}）。フォルダーの名前を変えるか移してください`);
      throw error;
    });
  } finally { await unlink(temporary).catch(() => undefined); }
  await unlink(join(folder, stale)).catch(() => undefined);
  // 一覧のカードの画像を、ファイルの監視を待たずに変える（監視は見回りの途中の変化を取りこぼすことがある）。
  notifyProjectStatusChanged(dirname(folder));
  return name;
}

/** 入力の固定（版＋内容の指紋）・素材の確認・案件ごとに同時 1 件・取消と後始末・一時ファイル→確定・要求 ID での照会。 */
export class ThumbnailExports {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly capture: ThumbnailCapture = captureThumbnail, private readonly inputs: ThumbnailRenderInputs = thumbnailRenderInputs,
    private readonly notify: (directory: string, event: ThumbnailEvent) => void = () => undefined) {}
  start(input: { directory: string; projectId: string; origin: string; request: ThumbnailExportRequest; state: () => ThumbnailSessionState }): ThumbnailExportStatus {
    const root = realpathSync(input.directory), request = input.request, key = `${root}\0${request.executionId}`, existing = this.jobs.get(key);
    if (existing) {
      if (existing.status.pageId !== request.pageId || existing.status.format !== request.format || existing.status.revision !== request.expectedRevision)
        throw new HttpError(409, '同じ書き出しIDに異なる要求があります');
      return { ...existing.status };
    }
    if ([...this.jobs.values()].some(job => job.directory === root && running(job))) throw new HttpError(409, '別のサムネを書き出し中です。終わってからもう一度押してください');
    const state = input.state();
    if (state.sessionId !== request.sessionId || state.document.revision !== request.expectedRevision) throw new HttpError(409, '編集内容が変わりました。もう一度書き出してください');
    const page = findPage(state.document, request.pageId), document = pageToSequence(state.document, request.pageId);
    const status: ThumbnailExportStatus = { executionId: request.executionId, jobId: `thumb-${randomUUID()}`, pageId: page.id, pageName: page.name,
      main: thumbnailMainPageId(state.document) === page.id,
      revision: state.document.revision, contentHash: createHash('sha256').update(sequenceContentBytes(document)).digest('hex'), format: request.format, phase: 'checking' };
    const job: Job = { key, directory: root, projectId: input.projectId, origin: input.origin, document, status, controller: new AbortController(), completion: Promise.resolve() };
    this.jobs.set(key, job);
    this.trim();
    job.completion = this.run(job);
    return { ...status };
  }
  status(directory: string, executionId: string): ThumbnailExportStatus | undefined {
    const job = this.jobs.get(`${realpathSync(directory)}\0${executionId}`);
    return job ? { ...job.status } : undefined;
  }
  async wait(directory: string, executionId: string): Promise<ThumbnailExportStatus> {
    const job = this.find(directory, executionId);
    await job.completion;
    return { ...job.status };
  }
  cancel(directory: string, executionId: string): ThumbnailExportStatus {
    const job = this.find(directory, executionId);
    job.controller.abort();
    return { ...job.status };
  }
  outputFile(directory: string, executionId: string): string {
    const job = this.find(directory, executionId);
    if (job.status.phase !== 'complete' || !job.status.fileName) throw new HttpError(409, '書き出しはまだ終わっていません');
    return join(job.directory, job.status.fileName);
  }
  killAll(): void { for (const job of this.jobs.values()) job.controller.abort(); }
  /** busy 照会用（jobRegistries）。実行中の書き出しがあれば phase を返す。 */
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
      const enabled = new Set(job.document.tracks.filter(track => track.enabled).map(track => track.id));
      for (const clip of job.document.clips) {
        const content = clip.content;
        if (!enabled.has(clip.trackId) || (content.kind !== 'image' && content.kind !== 'video')) continue;
        const asset = job.document.assets.find(item => item.id === content.assetId);
        try { if (!asset) throw new Error('素材がありません'); await verifiedSequenceAssetPath(job.directory, asset, signal); }
        catch {
          signal.throwIfAborted();
          throw new Error(content.kind === 'video' ? `元の動画が見つかりません（${asset?.name ?? content.assetId}）` : `画像が見つかりません（${asset?.name ?? content.assetId}）`);
        }
      }
      signal.throwIfAborted();
      status.phase = 'rendering'; this.emit(job);
      const release = this.inputs.register(job.directory, status.jobId, job.document);
      try {
        const shots = status.format === 'png' ? [{ format: 'png' as const }] : THUMBNAIL_JPEG_QUALITIES.map(quality => ({ format: 'jpeg' as const, quality }));
        const result = await this.capture({ origin: job.origin, projectId: job.projectId, jobId: status.jobId, resolution: job.document.resolution, signal }, shots,
          (bytes, shot) => shot.format === 'png' || bytes.length <= THUMBNAIL_MAX_BYTES);
        signal.throwIfAborted();
        const name = await publishThumbnail(join(job.directory, THUMBNAIL_EXPORT_FOLDER), thumbnailFileBase(basename(job.directory), status.pageName, status.main),
          status.format === 'png' ? '.png' : '.jpg', result.bytes);
        status.fileName = `${THUMBNAIL_EXPORT_FOLDER}/${name}`;
        status.bytes = result.bytes.length;
        status.overLimit = result.bytes.length > THUMBNAIL_MAX_BYTES;
        if (result.shot.quality !== undefined) status.quality = result.shot.quality;
        status.phase = 'complete';
      } finally { release(); }
    } catch (error) {
      status.phase = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) status.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    } finally { this.emit(job); }
  }
}
export const thumbnailExports = new ThumbnailExports(captureThumbnail, thumbnailRenderInputs, (directory, event) => thumbnailService.notify(directory, event));
