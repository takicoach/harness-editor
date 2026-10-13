import { realpathSync } from 'node:fs';
import type { SequenceDocument } from '../../core/sequence/model';
import { pageToSequence } from '../../core/thumbnail/pageToSequence';
import { HttpError } from '../http';
import { captureThumbnail, type ThumbnailCapture } from './capture';
import { thumbnailRenderInputs, type ThumbnailRenderInputs } from './renderInputs';
import { thumbnailService, type ThumbnailEvent, type ThumbnailSessionState } from './service';

export const THUMBNAIL_PREVIEW_WIDTH = 320;
interface PreviewJob { root: string; projectId: string; origin: string; pageId: string; contentHash: string; document: SequenceDocument }

/** 案の一覧とスマホでの見え方に使う縮小画像。書き出しと同じ撮影面で撮る。 */
export class ThumbnailPreviews {
  private readonly images = new Map<string, Buffer>();
  private readonly pending = new Map<string, PreviewJob>();
  private readonly running = new Map<string, string>();
  private shutdown = new AbortController();
  constructor(private readonly capture: ThumbnailCapture = captureThumbnail, private readonly inputs: ThumbnailRenderInputs = thumbnailRenderInputs,
    private readonly notify: (directory: string, event: ThumbnailEvent) => void = () => undefined) {}
  private key(root: string, pageId: string, contentHash: string): string { return `${root}\0${pageId}\0${contentHash}`; }
  request(input: { directory: string; projectId: string; origin: string; state: ThumbnailSessionState; pageId: string }): { pageId: string; contentHash: string; ready: boolean } {
    const root = realpathSync(input.directory), contentHash = input.state.pageHashes[input.pageId];
    if (!contentHash) throw new HttpError(404, '対象の案が見つかりません');
    if (this.images.has(this.key(root, input.pageId, contentHash))) return { pageId: input.pageId, contentHash, ready: true };
    // 同じ案の待ちは最新だけ残す（案件ごとに 1 件ずつ撮る）。
    this.pending.set(`${root}\0${input.pageId}`, { root, projectId: input.projectId, origin: input.origin, pageId: input.pageId, contentHash,
      document: pageToSequence(input.state.document, input.pageId) });
    if (!this.running.has(root)) void this.drain(root, input.projectId);
    return { pageId: input.pageId, contentHash, ready: false };
  }
  image(directory: string, pageId: string, contentHash: string): Buffer | undefined {
    return this.images.get(this.key(realpathSync(directory), pageId, contentHash));
  }
  private async drain(root: string, projectId: string): Promise<void> {
    this.running.set(root, projectId);
    try {
      for (;;) {
        const entry = [...this.pending.entries()].find(([key]) => key.startsWith(`${root}\0`));
        if (!entry) return;
        const [pendingKey, job] = entry;
        this.pending.delete(pendingKey);
        const jobId = `preview-${job.contentHash.slice(0, 24)}`, release = this.inputs.register(root, jobId, job.document);
        try {
          const scale = Math.min(1, THUMBNAIL_PREVIEW_WIDTH / job.document.resolution.width);
          const { bytes } = await this.capture({ origin: job.origin, projectId: job.projectId, jobId, resolution: job.document.resolution, signal: this.shutdown.signal },
            [{ format: 'png', scale }], () => true);
          this.remember(this.key(root, job.pageId, job.contentHash), bytes);
          this.notify(root, { type: 'preview', pageId: job.pageId, contentHash: job.contentHash });
        } catch (error) {
          console.warn('[sme] サムネの縮小画像を作れませんでした:', error instanceof Error ? error.message : error);
        } finally { release(); }
      }
    } finally { this.running.delete(root); }
  }
  /** サーバー停止時: 待ちを捨て、撮影中の Chromium を止める。以後の要求は新しい signal で動く。 */
  killAll(): void { this.pending.clear(); this.shutdown.abort(); this.shutdown = new AbortController(); }
  get(projectId: string, directory?: string): { phase: string } | undefined {
    const root = directory ? realpathSync(directory) : undefined;
    for (const [running, id] of this.running) if (root ? running === root : id === projectId) return { phase: 'rendering' };
    return undefined;
  }
  private remember(key: string, bytes: Buffer): void {
    this.images.delete(key); this.images.set(key, bytes);
    while (this.images.size > 30) this.images.delete(this.images.keys().next().value!);
  }
}
export const thumbnailPreviews = new ThumbnailPreviews(captureThumbnail, thumbnailRenderInputs, (directory, event) => thumbnailService.notify(directory, event));
