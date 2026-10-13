import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { SequenceAsset } from '../../core/sequence/model';
import { slidePageTitle } from '../../core/slides/build';
import type { SlideCommand } from '../../core/slides/commands';
import { SLIDES_OUTLINE_SCHEMA, SLIDES_PAGE_SCHEMA, validateOutline, validatePageBodies, type SlideIssue } from '../../core/slides/contract';
import { slideLayoutCatalog } from '../../core/slides/layouts';
import { SLIDES_MAX_PAGES_PER_REQUEST, SLIDES_MAX_REPAIRS, type SlideProposal } from '../../core/slides/model';
import { SLIDE_THEMES } from '../../core/slides/themes';
import { checkHandoffTarget, checkOperationId as checkHandoffOperationId, handoffRequestHash, replayHandoff, stableJson, type HandoffFail } from '../agentHandoff';
import { getProjectRoot, resolveProjectDir } from '../projectRoot';
import { importSequenceAsset } from '../sequence/assets';
import { resolveMaxUploadBytes } from '../streamUpload';
import { SlidesOperationLog, type SlidesOperationResult, type SlidesPageOutcome, type SlidesRoute, type SlidesTool } from './operations';
import { isSlidesProject, listSlidesProjects } from './projects';
import { slidesService, type SlidesService, type SlidesSessionState } from './service';

export { OPERATION_ID } from '../agentHandoff';
export type SlidesAgentErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'SESSION_CHANGED' | 'DOCUMENT_MISMATCH' | 'REVISION_CONFLICT' | 'OPERATION_MISMATCH' | 'RUN_MISMATCH' | 'RUN_STATE' | 'TARGET_NOT_REQUESTED';
/** 理由に加えて、次に何をすればよいか（recovery）を返す。 */
export class SlidesAgentError extends Error {
  constructor(readonly code: SlidesAgentErrorCode, message: string, readonly recovery: string) { super(message); this.name = 'SlidesAgentError'; }
}
export interface SlidesTarget { projectId: string; documentId: string; sessionId: string; expectedRevision: number }
export interface SlidesValidation { ok: boolean; issues: SlideIssue[]; pages: Array<{ key: string | null; index: number; ok: boolean; issues: SlideIssue[] }> }
type ApplyInput = SlidesTarget & { operationId: string; route: SlidesRoute; model?: string; payload: unknown };

/** 照合・再送判定は共通の関数（src/server/agentHandoff.ts）を使う。読み直しの道具はスライドでは slides_read。 */
const READER = 'slides_read';
const fail: HandoffFail = (code, message, recovery) => new SlidesAgentError(code, message, recovery);
/** 同じ要求かどうか。セッション ID は再起動で変わるので含めない（再送の照合ができるように）。 */
const requestHash = (tool: SlidesTool, input: Record<string, unknown>) => handoffRequestHash(tool, input, READER, fail);
const newRunId = () => `r${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
/** 先頭の印で、中身が画像（PNG・JPEG・WebP）かを確かめる（拡張子だけでは決めない）。 */
function isImageFile(file: string): boolean {
  const head = Buffer.alloc(12), fd = openSync(file, 'r');
  let read = 0;
  try { read = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  if (read >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  return read >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
}
const isInside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
/** MCP で受け取る画像の置き場所として認めるフォルダ（スライドの案件フォルダと、利用者のホーム）。 */
const defaultImageRoots = (directory: string) => [directory, homedir()];
const NOT_FOUND_RECOVERY = 'slides_read を引数なしで呼んで、スライドの一覧から projectId を確かめてください';

/** 生成の受け口。MCP の道具と貼り付けの経路（HTTP /apply）が同じ検証器・同じ記録を通る。 */
export class SlidesAgent {
  constructor(private readonly root: () => string = getProjectRoot, private readonly service: SlidesService = slidesService,
    private readonly importImage: (directory: string, file: string) => Promise<SequenceAsset> = (directory, file) => importSequenceAsset(directory, file),
    private readonly imageRoots: (directory: string) => string[] = defaultImageRoots) {}

  directory(projectId: unknown): string {
    if (typeof projectId !== 'string' || !projectId) throw new SlidesAgentError('INVALID_INPUT', 'projectId が必要です', NOT_FOUND_RECOVERY);
    const root = this.root();
    let directory: string;
    try { directory = resolveProjectDir(root, projectId); } catch { throw new SlidesAgentError('NOT_FOUND', 'スライド案件が見つかりません', NOT_FOUND_RECOVERY); }
    if (resolve(root) === resolve(directory) || !isSlidesProject(directory)) throw new SlidesAgentError('NOT_FOUND', 'スライド案件が見つかりません', NOT_FOUND_RECOVERY);
    return directory;
  }
  /** projectId なしでスライド案件の一覧。ありで、文書の ID・セッション・版・台本の段落・レイアウトの入力型・テーマ・生成の状態・ページの一覧。 */
  read(projectId?: string, options: { offset?: number; limit?: number } = {}) {
    if (projectId === undefined) return { projects: listSlidesProjects(this.root()) };
    const directory = this.directory(projectId), state = this.service.open(directory), document = state.document, generation = document.generation;
    const offset = Math.max(0, options.offset ?? 0), limit = Math.min(200, Math.max(1, options.limit ?? 100)), paragraphs = document.script.paragraphs;
    return {
      projectId, documentId: document.id, sessionId: state.sessionId, revision: document.revision, savedRevision: state.savedRevision, dirty: state.dirty,
      theme: { id: document.theme.id, name: SLIDE_THEMES[document.theme.id].name },
      schemas: { outline: SLIDES_OUTLINE_SCHEMA, page: SLIDES_PAGE_SCHEMA, maxPagesPerRequest: SLIDES_MAX_PAGES_PER_REQUEST, maxRepairsPerPage: SLIDES_MAX_REPAIRS },
      layouts: slideLayoutCatalog(),
      script: { total: paragraphs.length, offset, paragraphs: paragraphs.slice(offset, offset + limit), nextOffset: offset + limit < paragraphs.length ? offset + limit : null },
      generation: generation ? { runId: generation.runId, status: generation.status, confirmed: generation.confirmed, model: generation.model, glossary: generation.glossary,
        pages: generation.outline.map((entry, index) => { const state = generation.pages[index]!; return { ...entry, status: state.status, pageId: state.pageId, reasons: state.reasons, hasProposal: !!state.proposal }; }) } : null,
      pages: document.pages.map((page, index) => ({ number: index + 1, pageId: page.id, layout: page.layout, outlineKey: page.outlineKey ?? null, origin: page.origin,
        editedAfterGeneration: page.editedAfterGeneration, title: slidePageTitle(page), sourceParagraphIds: page.sourceParagraphIds })),
    };
  }
  /** 事前検証（文書を変えない）。 */
  validate(input: SlidesTarget & { kind: 'outline' | 'pages'; regenerate?: boolean; payload: unknown }): SlidesValidation {
    stableJson(input.payload, READER, fail);
    const { state } = this.target(input), document = state.document;
    if (input.kind === 'outline') { const result = validateOutline(document.script, input.payload); return { ok: !!result.outline, issues: result.issues, pages: [] }; }
    const result = validatePageBodies(document, input.payload, { regenerate: input.regenerate ?? false });
    return { ok: !result.requestIssues.length && result.pages.every(page => page.body !== null), issues: result.requestIssues,
      pages: result.pages.map(page => ({ key: page.key, index: page.index, ok: page.body !== null, issues: page.issues })) };
  }
  applyOutline(input: ApplyInput): SlidesOperationResult {
    const directory = this.directory(input.projectId); this.checkOperationId(input.operationId);
    const log = new SlidesOperationLog(directory);
    const hash = requestHash('apply-outline', { projectId: input.projectId, documentId: input.documentId, expectedRevision: input.expectedRevision, payload: input.payload });
    const replay = this.replay(log, input.operationId, hash);
    if (replay) return replay;
    const { state } = this.target(input), document = state.document;
    if (document.generation?.status === 'generating') throw new SlidesAgentError('RUN_STATE', '生成の途中です', '画面で「中止」を押してもらってから、構成案を出し直してください');
    const checked = validateOutline(document.script, input.payload);
    if (!checked.outline) return this.finish(log, hash, {}, this.result(input, 'apply-outline', 'rejected', null, state, checked.issues, []));
    const runId = newRunId();
    const saved = this.service.agentApply(directory, { sessionId: input.sessionId, expectedRevision: input.expectedRevision, executionId: `agent-${input.operationId}`,
      command: { type: 'set-outline', runId, outline: checked.outline.pages, glossary: checked.outline.glossary, model: input.model ?? null } });
    return this.finish(log, hash, {}, this.result(input, 'apply-outline', 'applied', runId, saved, [], []));
  }
  async applyPages(input: ApplyInput & { runId: string; regenerate?: boolean }): Promise<SlidesOperationResult> {
    const directory = this.directory(input.projectId); this.checkOperationId(input.operationId);
    const log = new SlidesOperationLog(directory), regenerate = input.regenerate ?? false;
    const hash = requestHash('apply-pages', { projectId: input.projectId, documentId: input.documentId, expectedRevision: input.expectedRevision, runId: input.runId, regenerate, payload: input.payload });
    const replay = this.replay(log, input.operationId, hash);
    if (replay) return replay;
    const { state } = this.target(input), document = state.document, generation = document.generation;
    if (!generation || generation.runId !== input.runId) throw new SlidesAgentError('RUN_MISMATCH', '生成の ID（runId）が違います', 'slides_read で generation.runId を確かめてください');
    if (generation.status === 'outline') throw new SlidesAgentError('RUN_STATE', '構成案がまだ確定していません', '画面で構成案を確かめて「この構成で作る」を押してもらってから、本文を作ってください');
    if (generation.status === 'cancelled') throw new SlidesAgentError('RUN_STATE', '生成は中止されています', '画面の「続きから作る」で再開してもらってから、本文を作ってください');
    const checked = validatePageBodies(document, input.payload, { regenerate });
    if (checked.requestIssues.length) return this.finish(log, hash, {}, this.result(input, 'apply-pages', 'rejected', input.runId, state, checked.requestIssues, []));
    const attempts: Record<string, number> = {}, outcomes: SlidesPageOutcome[] = [], bodies: SlideProposal[] = [], assets: SequenceAsset[] = [];
    const failures: Array<{ key: string; reasons: string[] }> = [];
    for (const page of checked.pages) {
      if (!page.body) {
        // 構成案にある key の内容の誤りだけを修復回数に数える（生成済み・重複は数えない）。
        const counted = page.key !== null && generation.outline.some(entry => entry.key === page.key) && !page.issues.some(issue => issue.code === 'ALREADY_GENERATED' || issue.code === 'DUPLICATE');
        if (!counted) { outcomes.push({ key: page.key, index: page.index, result: 'rejected', attempts: 0, issues: page.issues, notes: [] }); continue; }
        const count = log.attempts(input.runId, page.key!) + 1, failed = count > SLIDES_MAX_REPAIRS;
        attempts[`${input.runId}:${page.key}`] = count;
        if (failed) failures.push({ key: page.key!, reasons: page.issues.map(issue => `${issue.path}: ${issue.message}`) });
        outcomes.push({ key: page.key, index: page.index, result: failed ? 'failed' : 'rejected', attempts: count, issues: page.issues, notes: [] });
        continue;
      }
      const notes: string[] = [], images: Record<string, string> = {};
      for (const slot of page.body.imageSlots) {
        if (!slot.file) continue;
        if (input.route !== 'mcp') { notes.push(`画像枠「${slot.slot}」のファイルは貼り付けの経路では受け取れません。画面の「取り込み」から入れてください`); continue; }
        try {
          // シンボリックリンクは辿った先で判断する。認めるフォルダの外・画像でない中身は、素材台帳に登録する前に断る。
          const file = realpathSync(slot.file), roots = this.imageRoots(directory).flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } })
            .filter(root => root !== parse(root).root);
          if (!roots.some(root => isInside(root, file))) throw new Error('案件フォルダか、ホームフォルダの中の画像だけを取り込めます');
          const info = statSync(file);
          if (!info.isFile() || info.size > resolveMaxUploadBytes()) throw new Error('通常のファイルでないか、大きすぎます');
          if (!isImageFile(file)) throw new Error('画像として読み込めません（PNG・JPEG・WebP の画像を指定してください）');
          const asset = await this.importImage(directory, file);
          if (asset.kind !== 'image') throw new Error('画像として読み込めません');
          images[slot.slot] = asset.id;
          if (!assets.some(item => item.id === asset.id)) assets.push(asset);
        } catch (error) { notes.push(`画像枠「${slot.slot}」の画像を取り込めませんでした（${error instanceof Error ? error.message : String(error)}）。枠は空けたままにしました`); }
      }
      const body = { ...page.body, imageSlots: page.body.imageSlots.map(({ slot, prompt }) => ({ slot, prompt })) };
      const current = generation.pages.find(item => item.key === body.key)!, existing = current.pageId ? document.pages.find(item => item.id === current.pageId) : undefined;
      bodies.push({ body, images });
      outcomes.push({ key: body.key, index: page.index, result: existing?.editedAfterGeneration ? 'proposal' : 'applied', attempts: log.attempts(input.runId, body.key), issues: [], notes });
    }
    if (!bodies.length && !failures.length) return this.finish(log, hash, attempts, this.result(input, 'apply-pages', 'rejected', input.runId, state, [], outcomes));
    const apply: SlideCommand = { type: 'apply-page-bodies', runId: input.runId, bodies, failures, model: input.model ?? null };
    const saved = this.service.agentApply(directory, { sessionId: input.sessionId, expectedRevision: input.expectedRevision, executionId: `agent-${input.operationId}`,
      command: assets.length ? { type: 'batch', commands: [{ type: 'register-assets', assets }, apply] } : apply });
    const status = !bodies.length ? 'rejected' : outcomes.every(outcome => outcome.result === 'applied' || outcome.result === 'proposal') ? 'applied' : 'partial';
    return this.finish(log, hash, attempts, this.result(input, 'apply-pages', status, input.runId, saved, [], outcomes));
  }
  /** 取消（生成を中止する。適用済みのページは残り、画面の Undo で戻せる）。 */
  cancel(input: SlidesTarget & { operationId: string; route: SlidesRoute; runId: string }): SlidesOperationResult {
    const directory = this.directory(input.projectId); this.checkOperationId(input.operationId);
    const log = new SlidesOperationLog(directory);
    const hash = requestHash('cancel', { projectId: input.projectId, documentId: input.documentId, expectedRevision: input.expectedRevision, runId: input.runId });
    const replay = this.replay(log, input.operationId, hash);
    if (replay) return replay;
    const { state } = this.target(input), generation = state.document.generation;
    if (!generation || generation.runId !== input.runId) throw new SlidesAgentError('RUN_MISMATCH', '生成の ID（runId）が違います', 'slides_read で generation.runId を確かめてください');
    if (generation.status !== 'outline' && generation.status !== 'generating') throw new SlidesAgentError('RUN_STATE', '中止できる生成がありません', 'slides_runs で今の状態を確かめてください');
    const saved = this.service.agentApply(directory, { sessionId: input.sessionId, expectedRevision: input.expectedRevision, executionId: `agent-${input.operationId}`,
      command: { type: 'cancel-generation', runId: input.runId } });
    return this.finish(log, hash, {}, this.result(input, 'cancel', 'applied', input.runId, saved, [], []));
  }
  /** 結果照会。operationId を指定するとその操作の結果、無ければ生成の状態と最近の操作（新しい順）。 */
  runs(projectId: string, query: { operationId?: string; runId?: string; offset?: number; limit?: number } = {}) {
    const directory = this.directory(projectId), log = new SlidesOperationLog(directory);
    if (query.operationId) {
      const found = log.find(query.operationId);
      return found ? { operation: found.result }
        : { operation: null, note: 'この operationId の記録はありません（届いていないか、記録の前に止まりました）。slides_read で今の状態を確かめてから、新しい operationId で送り直してください' };
    }
    const generation = this.service.open(directory).document.generation, page = log.list({ runId: query.runId }, Math.max(0, query.offset ?? 0), Math.min(100, Math.max(1, query.limit ?? 20)));
    return {
      generation: generation ? { runId: generation.runId, status: generation.status, confirmed: generation.confirmed, model: generation.model,
        pages: generation.pages.map(state => ({ key: state.key, status: state.status, pageId: state.pageId, reasons: state.reasons, hasProposal: !!state.proposal, attempts: log.attempts(generation.runId, state.key) })) } : null,
      operations: page.items, nextOffset: page.nextOffset,
    };
  }
  private checkOperationId(operationId: unknown): void {
    checkHandoffOperationId(operationId, fail);
  }
  private target(input: SlidesTarget): { directory: string; state: SlidesSessionState } {
    const directory = this.directory(input.projectId);
    return { directory, state: checkHandoffTarget(input, () => this.service.inspect(directory, input.sessionId), READER, fail) };
  }
  private replay(log: SlidesOperationLog, operationId: string, hash: string): SlidesOperationResult | null {
    return replayHandoff(log.find(operationId), hash, fail);
  }
  private result(input: { operationId: string; route: SlidesRoute }, tool: SlidesTool, status: SlidesOperationResult['status'], runId: string | null,
    state: SlidesSessionState, issues: SlideIssue[], pages: SlidesPageOutcome[]): SlidesOperationResult {
    return { operationId: input.operationId, tool, route: input.route, status, replayed: false, runId, revision: state.document.revision, savedRevision: state.savedRevision,
      issues, pages, at: new Date().toISOString() };
  }
  private finish(log: SlidesOperationLog, requestHash: string, attempts: Record<string, number>, result: SlidesOperationResult): SlidesOperationResult {
    log.record({ operationId: result.operationId, requestHash, result }, attempts);
    return result;
  }
}
/** MCP の道具と HTTP が共有する。案件ルートは環境変数（HARNESS_PROJECT_ROOT）で決まる。 */
export const slidesAgent = new SlidesAgent();
