/**
 * 主画面の台帳（サーバ全体で 1 つ）。
 * - 主画面: AI タブを開いた画面（claim）。1 つだけで、別の画面が開けば移る。定期報告（beat）では移らない。
 * - 依頼時点: 端末で送信（Enter）された瞬間の主画面の状況（noteSubmit）。書き込みの対象確認に使う。
 * - AI が最後に確認: editor_context が呼ばれた時の主画面の状況（noteContextRead）。AI タブ上部の表示に使う。
 * 主画面が無いときに推測で案件を決めない（設計書 2）。
 */
import { aiFocusBeatSchema, TARGET_CONFIRM_RECOVERY, type AiContextRead, type AiFocusBeat, type AiFocusPrimary, type AiFocusView,
  type AiRequestPoint, type AiScreen } from '../shared/aiFocus';

/** この時間報告の無い画面は閉じたとみなす（画面は 2 秒ごとに報告する）。 */
export const AI_FOCUS_TTL_MS = 15_000;
export interface AiTargetDenial { code: 'TARGET_NOT_REQUESTED'; message: string; recovery: string }
/** 書き込みの道具の入口で呼ぶ。通してよければ null。 */
export type AiWriteGuard = (projectId: string) => AiTargetDenial | null;
interface PageEntry { seq: number; screen: AiScreen | null; updatedAt: number; expiresAt: number }

export class AiFocusRegistry {
  private readonly pages = new Map<string, PageEntry>();
  private primaryId: string | null = null;
  private requestPoint: AiRequestPoint | null = null;
  private lastRead: AiContextRead | null = null;
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = AI_FOCUS_TTL_MS) {}

  /** 画面の定期報告。主画面は動かさない。 */
  beat(input: unknown): { primary: boolean } {
    const beat = aiFocusBeatSchema.parse(input);
    this.expire();
    this.store(beat);
    return { primary: this.primaryId === beat.pageId };
  }
  /** AI タブを開いた画面を主画面にする。 */
  claim(input: unknown): void {
    const beat = aiFocusBeatSchema.parse(input);
    this.expire();
    this.store(beat);
    this.primaryId = beat.pageId;
  }
  release(pageId: string): void {
    this.pages.delete(pageId);
    if (this.primaryId === pageId) this.primaryId = null;
  }
  primary(): AiFocusPrimary | null {
    this.expire();
    const entry = this.primaryId === null ? undefined : this.pages.get(this.primaryId);
    return entry && this.primaryId !== null ? { pageId: this.primaryId, screen: entry.screen, updatedAt: entry.updatedAt } : null;
  }
  /** 端末で送信された。その時の主画面の状況を依頼時点にする（主画面が無い・ホームなら依頼時点は無し）。 */
  noteSubmit(): AiRequestPoint | null {
    const screen = this.primary()?.screen ?? null;
    this.requestPoint = screen ? { projectId: screen.projectId, projectName: screen.projectName, mode: screen.mode, at: this.now() } : null;
    return this.requestPoint;
  }
  request(): AiRequestPoint | null { return this.requestPoint; }
  noteContextRead(): void {
    const screen = this.primary()?.screen ?? null;
    this.lastRead = { projectId: screen?.projectId ?? null, projectName: screen?.projectName ?? null, mode: screen?.mode ?? null, at: this.now() };
  }
  view(): AiFocusView { return { primary: this.primary(), request: this.requestPoint, lastRead: this.lastRead }; }
  /** 対象の案件が依頼時点の案件と同じなら通す。同じ案件の中でモードが変わっていても通す（設計書 3）。 */
  checkWriteTarget(projectId: string): AiTargetDenial | null {
    const request = this.requestPoint;
    if (request?.projectId === projectId) return null;
    return { code: 'TARGET_NOT_REQUESTED', recovery: TARGET_CONFIRM_RECOVERY, message: request
      ? `依頼した時点の案件は「${request.projectName}」です。別の案件（${projectId}）には書き込めません`
      : '利用者がまだ AI タブで依頼していないため、書き込む案件を確かめられません' };
  }
  private store(beat: AiFocusBeat): void {
    const current = this.pages.get(beat.pageId), now = this.now();
    if (current && beat.seq <= current.seq) { current.expiresAt = now + this.ttlMs; return; }
    this.pages.set(beat.pageId, { seq: beat.seq, screen: beat.screen, updatedAt: now, expiresAt: now + this.ttlMs });
  }
  private expire(): void {
    const now = this.now();
    for (const [pageId, entry] of this.pages) {
      if (entry.expiresAt > now) continue;
      this.pages.delete(pageId);
      if (this.primaryId === pageId) this.primaryId = null;
    }
  }
}

export const aiFocus = new AiFocusRegistry();
