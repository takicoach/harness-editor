import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { SequenceDocument } from '../../core/sequence/model';
import { SLIDES_CANVAS, SLIDES_MAX_PAGES } from '../../core/slides/model';
import { slidePageToSequence } from '../../core/slides/pageView';
import { HttpError } from '../http';
import { captureSlides, type SlidesCapture } from './capture';
import { slidesRenderInputs, type SlidesRenderInputs } from './renderInputs';
import { slidesService, type SlidesEvent, type SlidesSessionState } from './service';

export const SLIDES_PREVIEW_WIDTH = 320;
/** 撮影に失敗したページは、この間は自動で撮り直さない（失敗を返す）。過ぎるか retry で撮り直す。 */
export const SLIDES_PREVIEW_RETRY_MS = 30_000;
const BUSY_MESSAGE = 'ほかの重い処理が進行中のため、縮小画像は終わってから作ります';
interface PreviewJob { pageId: string; contentHash: string; origin: string; projectId: string; document: SequenceDocument }
export interface SlidesPreviewResult { pageId: string; contentHash: string; ready: boolean; failed?: true; error?: string }

/** ページの帯と格子表示の縮小画像。書き出しと同じ描画面で、待っているページをまとめて撮る。案件ごとに同時 1 件。 */
export class SlidesPreviews {
  private readonly images = new Map<string, Buffer>();
  private readonly pending = new Map<string, PreviewJob>();
  private readonly running = new Map<string, string>();
  /** 撮影に失敗したページ（key → 理由と時刻）。 */
  private readonly failures = new Map<string, { error: string; at: number }>();
  private shutdown = new AbortController();
  constructor(private readonly capture: SlidesCapture = captureSlides, private readonly inputs: SlidesRenderInputs = slidesRenderInputs,
    private readonly notify: (directory: string, event: SlidesEvent) => void = () => undefined, private readonly now: () => number = Date.now) {}
  private key(root: string, pageId: string, contentHash: string): string { return `${root}\0${pageId}\0${contentHash}`; }
  /** allowed は重い処理の枠（heavyJobGate）が空いているか。空いていなければ新しく Chromium を起動せず、理由付きで返す。
   * 撮影に失敗したページは失敗と理由を返し、retry か時間が経つまで自動では撮り直さない。 */
  request(input: { directory: string; projectId: string; origin: string; state: SlidesSessionState; pageIds: readonly string[]; retry?: boolean; allowed?: boolean }): SlidesPreviewResult[] {
    const root = realpathSync(input.directory), queued: string[] = [];
    const results = input.pageIds.slice(0, SLIDES_MAX_PAGES).map((pageId): SlidesPreviewResult => {
      const contentHash = input.state.pageHashes[pageId];
      if (!contentHash) throw new HttpError(404, '対象のページが見つかりません');
      const key = this.key(root, pageId, contentHash);
      if (this.images.has(key)) return { pageId, contentHash, ready: true };
      const failure = this.failures.get(key);
      if (failure && !input.retry && this.now() - failure.at < SLIDES_PREVIEW_RETRY_MS) return { pageId, contentHash, ready: false, failed: true, error: failure.error };
      this.failures.delete(key);
      // 同じページの待ちは最新だけ残す。
      this.pending.set(`${root}\0${pageId}`, { pageId, contentHash, origin: input.origin, projectId: input.projectId, document: slidePageToSequence(input.state.document, pageId) });
      queued.push(pageId);
      return { pageId, contentHash, ready: false };
    });
    if (!this.running.has(root) && [...this.pending.keys()].some(key => key.startsWith(`${root}\0`))) {
      if (input.allowed === false) {
        // 撮影中でなければ待ちを持たない（あとで頼み直してもらう）。
        for (const key of [...this.pending.keys()]) if (key.startsWith(`${root}\0`)) this.pending.delete(key);
        return results.map(item => queued.includes(item.pageId) ? { ...item, failed: true, error: BUSY_MESSAGE } : item);
      }
      void this.drain(root, input.projectId);
    }
    return results;
  }
  /** 重い処理の枠（heavyJobGate）に数える、撮影中の案件の数。 */
  activeCount(): number { return this.running.size; }
  image(directory: string, pageId: string, contentHash: string): Buffer | undefined {
    return this.images.get(this.key(realpathSync(directory), pageId, contentHash));
  }
  private async drain(root: string, projectId: string): Promise<void> {
    this.running.set(root, projectId);
    try {
      for (;;) {
        const entries = [...this.pending.entries()].filter(([key]) => key.startsWith(`${root}\0`));
        if (!entries.length) return;
        for (const [key] of entries) this.pending.delete(key);
        const jobs = entries.map(([, job]) => job), jobId = `slides-preview-${randomUUID()}`, release = this.inputs.register(root, jobId, jobs.map(job => job.document));
        const signal = this.shutdown.signal;
        try {
          await this.capture({ origin: jobs[0]!.origin, projectId: jobs[0]!.projectId, jobId, signal }, jobs.length,
            { format: 'png', scale: SLIDES_PREVIEW_WIDTH / SLIDES_CANVAS.width }, (index, bytes) => {
              const job = jobs[index]!;
              this.remember(this.key(root, job.pageId, job.contentHash), bytes);
              this.notify(root, { type: 'preview', pageId: job.pageId, contentHash: job.contentHash });
            });
        } catch (error) {
          console.warn('[sme] スライドの縮小画像を作れませんでした:', error instanceof Error ? error.message : error);
          if (!signal.aborted) {
            // 撮れなかったページに失敗と理由を知らせる（画面は待ちを止め、頼み直せる）。
            const message = `縮小画像を作れませんでした（${(error instanceof Error ? error.message : String(error)).slice(0, 200)}）`, at = this.now();
            for (const job of jobs) {
              const key = this.key(root, job.pageId, job.contentHash);
              if (this.images.has(key)) continue;
              this.failures.set(key, { error: message, at });
              this.notify(root, { type: 'preview', pageId: job.pageId, contentHash: job.contentHash, error: message });
            }
            while (this.failures.size > 400) this.failures.delete(this.failures.keys().next().value!);
          }
        } finally { release(); }
      }
    } finally { this.running.delete(root); }
  }
  /** サーバー停止時: 待ちを捨て、撮影中の Chromium を止める。以後の要求は新しい signal で動く。 */
  killAll(): void { this.pending.clear(); this.failures.clear(); this.shutdown.abort(); this.shutdown = new AbortController(); }
  get(projectId: string, directory?: string): { phase: string } | undefined {
    const root = directory ? realpathSync(directory) : undefined;
    for (const [running, id] of this.running) if (root ? running === root : id === projectId) return { phase: 'rendering' };
    return undefined;
  }
  private remember(key: string, bytes: Buffer): void {
    this.images.delete(key); this.images.set(key, bytes);
    while (this.images.size > 400) this.images.delete(this.images.keys().next().value!);
  }
}
export const slidesPreviews = new SlidesPreviews(captureSlides, slidesRenderInputs, (directory, event) => slidesService.notify(directory, event));
