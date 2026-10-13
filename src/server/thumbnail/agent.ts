/**
 * サムネの AI の受け渡し。サムネの service.ts は変えず、外側で
 * 依頼の固定（範囲）・下書き・1 回の確定・結果の照会を行う。適用は execute、保存は save。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceAsset } from '../../core/sequence/model';
import type { Rational } from '../../core/sequence/time';
import { applyThumbnailCommand } from '../../core/thumbnail/commands';
import { THUMBNAIL_MAX_PAGES, type ThumbnailDocument } from '../../core/thumbnail/model';
import { THUMBNAIL_AI_MAX_FRAME_REFS, THUMBNAIL_AI_MAX_FRAMES_PER_CALL, THUMBNAIL_AI_MAX_PREVIEWS, type ThumbnailAiApply, type ThumbnailAiCutout, type ThumbnailAiKind, type ThumbnailAiPhase, type ThumbnailAiRequest } from '../../shared/thumbnailAi';
import { checkOperationId, handoffRequestHash, replayHandoff, type HandoffFail } from '../agentHandoff';
import { normalizeInstructionId } from '../instructionInbox';
import { getProjectRoot, resolveProjectDir } from '../projectRoot';
import { cacheDirectory } from '../sequence/media';
import { SequenceStore } from '../sequence/store';
import { evictThumbnailAiCache } from './aiCache';
import { buildThumbnailAiCommand, checkThumbnailAiTarget, NEW_PAGE, thumbnailPageFingerprint, ThumbnailAiScopeError } from './aiCommand';
import { thumbnailAiRender, ThumbnailAiSourceMissing, type ThumbnailAiRender } from './aiRender';
import { ThumbnailAiRequestStore } from './aiRequests';
import { ThumbnailConflictError, thumbnailService, type ThumbnailService } from './service';

export type ThumbnailAgentErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'OUT_OF_REQUEST' | 'TARGET_CHANGED' | 'PAGE_LIMIT' | 'DOCUMENT_MISMATCH' | 'REVISION_CONFLICT'
  | 'OPERATION_MISMATCH' | 'ALREADY_APPLIED' | 'SOURCE_MISSING' | 'PREVIEW_LIMIT' | 'RENDER_FAILED' | 'TARGET_NOT_REQUESTED' | 'SESSION_CHANGED';
export class ThumbnailAgentError extends Error {
  constructor(readonly code: ThumbnailAgentErrorCode, message: string, readonly recovery: string) { super(message); this.name = 'ThumbnailAgentError'; }
}
export interface ThumbnailAiApplyResult { requestId: string; operationId: string; status: ThumbnailAiApply['status']; pageId: string; revision: number | null; savedRevision: number | null; message: string | null; replayed: boolean }
const READER = 'thumbnail_read';
const fail: HandoffFail = (code, message, recovery) => new ThumbnailAgentError(code, message, recovery);
const NOT_FOUND_RECOVERY = '依頼番号は貼られた依頼文の「（依頼 #番号）」、端末から直接頼まれた時は thumbnail_begin が返した requestId を使ってください。projectId は依頼を受けた時の editor_context の request.projectId です';
const scope = (error: unknown): never => {
  if (error instanceof ThumbnailAiScopeError) throw new ThumbnailAgentError(error.code, error.message, error.recovery);
  if (error instanceof SequenceError) throw new ThumbnailAgentError('INVALID_INPUT', error.message, `${READER} で今の案を読み直し、操作を直して送ってください`);
  throw error;
};
const now = () => new Date().toISOString();
const seconds = (value: { num: number; den: number }) => value.num / value.den;

export class ThumbnailAgent {
  private readonly root: () => string;
  private readonly service: ThumbnailService;
  private readonly render: ThumbnailAiRender;
  constructor(deps: { root?: () => string; service?: ThumbnailService; render?: ThumbnailAiRender } = {}) {
    this.root = deps.root ?? getProjectRoot; this.service = deps.service ?? thumbnailService; this.render = deps.render ?? thumbnailAiRender;
  }

  directory(projectId: unknown): string {
    if (typeof projectId !== 'string' || !projectId) throw new ThumbnailAgentError('INVALID_INPUT', 'projectId が必要です', NOT_FOUND_RECOVERY);
    const root = this.root();
    let directory: string;
    try { directory = resolveProjectDir(root, projectId); } catch { throw new ThumbnailAgentError('NOT_FOUND', '案件が見つかりません', NOT_FOUND_RECOVERY); }
    if (resolve(root) === resolve(directory) || !existsSync(directory)) throw new ThumbnailAgentError('NOT_FOUND', '案件が見つかりません', NOT_FOUND_RECOVERY);
    return directory;
  }
  private state(directory: string) {
    try { return this.service.open(directory); }
    catch { throw new ThumbnailAgentError('NOT_FOUND', 'この案件にはまだサムネがありません', '利用者にサムネの画面を開いてもらってから頼み直してもらってください'); }
  }
  /** 依頼の記録の中身を作る（確かめるだけで保存しない）。ボタンの依頼と thumbnail_begin が共有する。 */
  draft(input: { projectId: string; kind: ThumbnailAiKind; pageId: string | null; cutout: ThumbnailAiCutout; note: string; route: 'button' | 'direct' }): Omit<ThumbnailAiRequest, 'requestId'> {
    const document = this.state(this.directory(input.projectId)).document;
    if (input.kind === 'edit' && input.pageId === null) throw new ThumbnailAgentError('INVALID_INPUT', '直す案（pageId）が必要です', 'editor_context の screen.target.pageId を渡してください');
    if (input.kind === 'new' && input.pageId === null && document.pages.length >= THUMBNAIL_MAX_PAGES)
      throw new ThumbnailAgentError('PAGE_LIMIT', `案が ${THUMBNAIL_MAX_PAGES} つあります`, '入れ替える案を利用者に聞いてから、その案の ID を replacePageId に入れて呼び直してください');
    // 入れ替えは案が上限の時だけ。それ未満で入れ替える案を受けると、頼まれていない案を消してしまう。
    if (input.kind === 'new' && input.pageId !== null && document.pages.length < THUMBNAIL_MAX_PAGES)
      throw new ThumbnailAgentError('INVALID_INPUT', `案が ${THUMBNAIL_MAX_PAGES} つ未満の時は、案を入れ替えられません（今は ${document.pages.length} つ）`,
        '入れ替える案（replacePageId）を付けずに、新しい案として頼み直してください');
    const page = input.pageId === null ? null : document.pages.find(item => item.id === input.pageId);
    if (page === undefined) throw new ThumbnailAgentError('NOT_FOUND', '指定した案がありません', `${READER} か editor_context で案の ID を確かめてください`);
    const at = now();
    return { route: input.route, projectId: input.projectId, documentId: document.id, kind: input.kind, targetPageId: page?.id ?? null, targetPageName: page?.name ?? null,
      targetFingerprint: page ? thumbnailPageFingerprint(page) : null, cutout: input.cutout, note: input.note.replace(/\s+/g, ' ').trim().slice(0, 100), phase: 'working',
      frames: [], nextFrame: 1, previews: 0, apply: null, createdAt: at, updatedAt: at };
  }
  store(projectId: string, request: ThumbnailAiRequest): void { new ThumbnailAiRequestStore(this.directory(projectId)).put(request); }
  /** 端末から直接頼まれた時の依頼の記録。依頼時点の確認は MCP の入口（mcpTools）で行う。 */
  begin(input: { projectId: string; kind: ThumbnailAiKind; pageId?: string; replacePageId?: string; cutout?: ThumbnailAiCutout; note?: string }) {
    const draft = this.draft({ projectId: input.projectId, kind: input.kind, pageId: input.kind === 'edit' ? input.pageId ?? null : input.replacePageId ?? null,
      cutout: input.cutout ?? 'auto', note: input.note ?? '', route: 'direct' });
    const request: ThumbnailAiRequest = { requestId: `d-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, ...draft };
    this.store(input.projectId, request);
    return { requestId: request.requestId, kind: request.kind, targetPageId: request.targetPageId, targetPageName: request.targetPageName,
      next: '以後の thumbnail_* にはこの requestId と projectId を渡してください。端末で利用者が答えても、この依頼の対象は変わりません' };
  }
  private request(projectId: string, requestId: unknown): { directory: string; store: ThumbnailAiRequestStore; request: ThumbnailAiRequest } {
    const directory = this.directory(projectId), store = new ThumbnailAiRequestStore(directory);
    const request = typeof requestId === 'string' ? store.get(normalizeInstructionId(requestId)) : undefined;
    if (!request) throw new ThumbnailAgentError('NOT_FOUND', 'この案件にその依頼番号の記録はありません', NOT_FOUND_RECOVERY);
    return { directory, store, request };
  }
  latest(projectId: string): ThumbnailAiRequest | undefined { return new ThumbnailAiRequestStore(this.directory(projectId)).latest(); }
  find(projectId: string, requestId: string): ThumbnailAiRequest | undefined { return new ThumbnailAiRequestStore(this.directory(projectId)).get(requestId); }
  /** 背景に使える動画（動画の編集で使っている素材と、サムネにすでにある動画）。 */
  usableVideos(directory: string, document: ThumbnailDocument): SequenceAsset[] {
    const video = new SequenceStore(directory).load()?.document.assets ?? [], seen = new Set<string>();
    return [...document.assets, ...video].filter(asset => asset.kind === 'media' && asset.streams.some(stream => stream.kind === 'video') && !seen.has(asset.id) && !!seen.add(asset.id));
  }
  read(input: { projectId: string; requestId: string; transcriptOffset?: number; transcriptLimit?: number }) {
    const { directory, request } = this.request(input.projectId, input.requestId), state = this.state(directory), document = state.document;
    const videos = this.usableVideos(directory, document).map(asset => {
      const stream = asset.streams.find(item => item.kind === 'video')!;
      return { assetId: asset.id, name: asset.name, streamIndex: stream.index, seconds: seconds(stream.duration), width: stream.width ?? null, height: stream.height ?? null };
    });
    const lines = this.transcriptLines(directory), offset = Math.max(0, input.transcriptOffset ?? 0), limit = Math.min(300, Math.max(1, input.transcriptLimit ?? 150));
    return {
      request: { requestId: request.requestId, kind: request.kind, targetPageId: request.targetPageId, targetPageName: request.targetPageName, cutout: request.cutout, note: request.note,
        phase: request.phase, frames: request.frames.map(({ frameId, assetId, sourceTime, file }) => ({ frameId, assetId, seconds: seconds(sourceTime), path: file })), apply: request.apply },
      document: { id: document.id, revision: document.revision, canvas: document.canvas, mainPageId: document.mainPageId ?? document.pages[0]!.id,
        pages: document.pages, assets: document.assets.map(({ id, kind, name }) => ({ id, kind, name })) },
      videos, transcript: { lines: lines.slice(offset, offset + limit), nextOffset: offset + limit < lines.length ? offset + limit : null },
      next: request.apply ? 'この依頼はもう確定しています。thumbnail_runs で結果を確かめてください' : '手順は editor_guide(\'thumbnail\')。確定は thumbnail_apply を 1 回だけ',
    };
  }
  /** 字幕を行にする（元の秒）。句点・感嘆・疑問で区切り、0.8 秒以上の間か 40 文字でも区切る。 */
  private transcriptLines(directory: string): Array<{ assetId: string; start: number; end: number; text: string }> {
    const lines: Array<{ assetId: string; start: number; end: number; text: string }> = [];
    for (const transcript of new SequenceStore(directory).load()?.document.transcripts ?? []) {
      let current: { assetId: string; start: number; end: number; text: string } | null = null;
      for (const word of transcript.words) {
        const start = seconds(word.start), end = seconds(word.end);
        if (current && (start - current.end >= 0.8 || current.text.length >= 40)) { lines.push(current); current = null; }
        current = current ? { assetId: current.assetId, start: current.start, end, text: current.text + word.text } : { assetId: transcript.assetId, start, end, text: word.text };
        if (/[。！？!?]$/.test(word.text)) { lines.push(current); current = null; }
      }
      if (current) lines.push(current);
    }
    return lines.sort((a, b) => a.start - b.start);
  }
  apply(input: { projectId: string; requestId: string; operationId: string; baseRevision: number; ops: unknown }): ThumbnailAiApplyResult {
    const { directory, store, request } = this.request(input.projectId, input.requestId);
    checkOperationId(input.operationId, fail);
    const hash = handoffRequestHash('thumbnail_apply', { projectId: input.projectId, requestId: request.requestId, baseRevision: input.baseRevision, ops: input.ops }, READER, fail);
    if (request.apply) {
      if (request.apply.operationId === input.operationId) return replayHandoff({ requestHash: request.apply.requestHash, result: this.result(request, request.apply, false) }, hash, fail)!;
      throw new ThumbnailAgentError('ALREADY_APPLIED', 'この依頼はもう確定しました（確定は 1 つの依頼で 1 回）', 'thumbnail_runs で結果を確かめてください。さらに直す時は、利用者に「直す」で頼み直してもらってください');
    }
    const state = this.state(directory), document = state.document;
    if (document.id !== request.documentId) throw new ThumbnailAgentError('DOCUMENT_MISMATCH', 'サムネの文書が依頼の時と違います', '利用者に、このまま続けるか確かめてください');
    try { checkThumbnailAiTarget(document, request); } catch (error) { scope(error); }
    if (document.revision !== input.baseRevision) throw new ThumbnailAgentError('REVISION_CONFLICT', `版が変わっています（今は ${document.revision}）。依頼の対象の案は変わっていません`,
      `${READER} で読み直し、今の内容に合わせて新しい operationId で送ってください`);
    let built: ReturnType<typeof buildThumbnailAiCommand>;
    try { built = buildThumbnailAiCommand({ document, request, ops: input.ops, videos: this.usableVideos(directory, document), newPageId: `page-${randomUUID()}` }); applyThumbnailCommand(document, built.command); }
    catch (error) { return scope(error); }
    // 実行 ID は依頼番号から作らない。受け箱の番号（inst-N）は別プロセスで振り直されて使い回され、保存の受領記録（サムネのファイルに残る）が同じ ID の別の中身を conflict にするため。
    const executionId = `ai-${randomUUID()}`;
    const pending: ThumbnailAiApply = { operationId: input.operationId, requestHash: hash, status: 'applying', pageId: built!.pageId, appliedRevision: null, savedRevision: null, message: null, evacuatedFile: null, at: now() };
    store.update(request.requestId, current => ({ ...current, apply: pending, updatedAt: now() }));
    let executed: ReturnType<ThumbnailService['execute']>;
    try { executed = this.service.execute(directory, { sessionId: state.sessionId, expectedRevision: document.revision, executionId, command: built!.command }); }
    catch (error) { store.update(request.requestId, current => ({ ...current, apply: null })); return scope(error); }
    let done: ThumbnailAiApply = { ...pending, appliedRevision: executed.appliedRevision };
    try {
      const saved = this.service.save(directory, { sessionId: state.sessionId, expectedRevision: executed.document.revision, expectedSavedRevision: executed.savedRevision, executionId: `${executionId}:save` });
      done = { ...done, status: 'saved', savedRevision: saved.savedRevision };
    } catch (error) {
      done = error instanceof ThumbnailConflictError
        ? { ...done, status: 'conflict', message: error.message, evacuatedFile: error.evacuatedFile ?? null }
        : { ...done, status: 'save-failed', message: `保存できませんでした（${error instanceof Error ? error.message : String(error)}）。画面は未保存の表示です。利用者が保存を押せます` };
    }
    store.update(request.requestId, current => ({ ...current, apply: done, updatedAt: now() }));
    return this.result(request, done, false);
  }
  /** 作業中の依頼（未確定で 24 時間以内に動いたもの）の画像は消さない。 */
  private async cache(directory: string): Promise<{ folder: string; tidy: () => Promise<void> }> {
    const folder = await cacheDirectory(directory, 'thumbnail-ai'), store = new ThumbnailAiRequestStore(directory);
    return { folder, tidy: async () => {
      const busy = store.all().filter(item => !item.apply && Date.now() - Date.parse(item.updatedAt) < 86_400_000).map(item => `${item.requestId}-`);
      await evictThumbnailAiCache(folder, name => busy.some(prefix => name.startsWith(prefix)));
    } };
  }
  private renderError(error: unknown): never {
    if (error instanceof ThumbnailAgentError) throw error;
    if (error instanceof ThumbnailAiSourceMissing) throw new ThumbnailAgentError('SOURCE_MISSING', '元の動画が見つかりません（移動したか、中身が変わっています）', '利用者に、元の動画の場所を確かめてもらってください');
    throw new ThumbnailAgentError('RENDER_FAILED', `描画できませんでした（${error instanceof Error ? error.message : String(error)}）`, '少し待ってもう一度呼んでください。続く時は利用者に伝えてください');
  }
  /** 秒を、そのコマの中央の時刻にする（画面のコマ選び framePick と同じ考え方）。 */
  private frameTime(value: number, stream: SequenceAsset['streams'][number]): Rational {
    const fps = stream.frameRate ?? { num: 30, den: 1 }, last = Math.max(0, Math.floor(seconds(stream.duration) * fps.num / fps.den) - 1);
    const frame = Math.min(last, Math.max(0, Math.floor(value * fps.num / fps.den)));
    return { num: (2 * frame + 1) * fps.den, den: 2 * fps.num };
  }
  async frames(input: { projectId: string; requestId: string; assetId: string; streamIndex?: number; seconds?: number[]; range?: { start: number; end: number; count: number } }, origin: string, signal = new AbortController().signal) {
    const { directory, store, request } = this.request(input.projectId, input.requestId), document = this.state(directory).document;
    const asset = this.usableVideos(directory, document).find(item => item.id === input.assetId);
    if (!asset) throw new ThumbnailAgentError('NOT_FOUND', 'その動画はこの案件で使えません', `${READER} の videos から assetId を選んでください`);
    const stream = asset.streams.find(item => item.kind === 'video' && (input.streamIndex === undefined || item.index === input.streamIndex));
    if (!stream) throw new ThumbnailAgentError('NOT_FOUND', '映像のストリームがありません', `${READER} の videos の streamIndex を使ってください`);
    const wanted = input.seconds ?? (input.range ? Array.from({ length: input.range.count }, (_v, index) => input.range!.count === 1 ? input.range!.start
      : input.range!.start + (input.range!.end - input.range!.start) * index / (input.range!.count - 1)) : []);
    if ((input.seconds === undefined) === (input.range === undefined) || wanted.length < 1 || wanted.length > THUMBNAIL_AI_MAX_FRAMES_PER_CALL || wanted.some(value => !Number.isFinite(value) || value < 0))
      throw new ThumbnailAgentError('INVALID_INPUT', `seconds か range のどちらか 1 つで、1〜${THUMBNAIL_AI_MAX_FRAMES_PER_CALL} 枚にしてください`, '秒は 0 以上の数で渡してください');
    const times = wanted.map(value => this.frameTime(value, stream));
    // コマ ID は描画の前に確保する（描画を待つ間にほかの呼び出しと重ならないように）。
    const first = store.update(request.requestId, current => ({ ...current, nextFrame: current.nextFrame + times.length, phase: 'working', updatedAt: now() })).nextFrame - times.length;
    let shot: Awaited<ReturnType<ThumbnailAiRender['frames']>>;
    try { shot = await this.render.frames({ directory, projectId: input.projectId, origin, asset, streamIndex: stream.index, times, longSide: 640, signal }); }
    catch (error) { return this.renderError(error); }
    const { folder, tidy } = await this.cache(directory);
    const frames = times.map((sourceTime, index) => {
      const frameId = `f${first + index}`, file = join(folder, `${request.requestId}-${frameId}.jpg`);
      writeFileSync(file, shot.images[index]!);
      return { frameId, assetId: asset.id, streamIndex: stream.index, fingerprint: asset.fingerprint, sourceTime, file };
    });
    store.update(request.requestId, current => ({ ...current, frames: [...current.frames, ...frames].slice(-THUMBNAIL_AI_MAX_FRAME_REFS), updatedAt: now() }));
    await tidy();
    return { frames: frames.map(frame => ({ frameId: frame.frameId, path: frame.file, width: shot.width, height: shot.height, seconds: seconds(frame.sourceTime),
      assetId: frame.assetId, streamIndex: frame.streamIndex, fingerprint: frame.fingerprint })) };
  }
  async preview(input: { projectId: string; requestId: string; ops: unknown }, origin: string, signal = new AbortController().signal) {
    const { directory, store, request } = this.request(input.projectId, input.requestId), document = this.state(directory).document;
    if (request.previews >= THUMBNAIL_AI_MAX_PREVIEWS) throw new ThumbnailAgentError('PREVIEW_LIMIT', `下書きは 1 つの依頼で ${THUMBNAIL_AI_MAX_PREVIEWS} 回までです`, '今の内容で thumbnail_apply で確定するか、利用者に相談してください');
    let next: ThumbnailDocument, pageId: string;
    try {
      checkThumbnailAiTarget(document, request);
      const built = buildThumbnailAiCommand({ document, request, ops: input.ops, videos: this.usableVideos(directory, document), newPageId: `page-preview-${request.requestId}` });
      next = applyThumbnailCommand(document, built.command); pageId = built.pageId;
    } catch (error) { return scope(error); }
    const count = store.update(request.requestId, current => ({ ...current, previews: current.previews + 1, phase: 'reviewing', updatedAt: now() })).previews;
    let image: Awaited<ReturnType<ThumbnailAiRender['page']>>;
    try { image = await this.render.page({ directory, projectId: input.projectId, origin, document: next!, pageId: pageId!, longSide: 1280, signal }); }
    catch (error) { return this.renderError(error); }
    const { folder, tidy } = await this.cache(directory), path = join(folder, `${request.requestId}-preview-${count}.png`);
    writeFileSync(path, image.bytes);
    await tidy();
    return { path, width: image.width, height: image.height, pageId: request.kind === 'new' ? NEW_PAGE : pageId!, revision: document.revision, previewsLeft: THUMBNAIL_AI_MAX_PREVIEWS - count };
  }
  runs(input: { projectId: string; requestId: string }): { requestId: string; kind: ThumbnailAiKind; phase: ThumbnailAiPhase; apply: ThumbnailAiApply | null; note: string } {
    const { request } = this.request(input.projectId, input.requestId);
    const note = !request.apply ? '未確定です' : request.apply.status === 'applying'
      ? '確定の途中で止まった可能性があります。thumbnail_read で案があるか確かめ、無ければ利用者に頼み直してもらってください' : '確定の結果です';
    return { requestId: request.requestId, kind: request.kind, phase: request.phase, apply: request.apply, note };
  }
  private result(request: ThumbnailAiRequest, apply: ThumbnailAiApply, replayed: boolean): ThumbnailAiApplyResult {
    return { requestId: request.requestId, operationId: apply.operationId, status: apply.status, pageId: apply.pageId, revision: apply.appliedRevision,
      savedRevision: apply.savedRevision, message: apply.message, replayed };
  }
}
export const thumbnailAgent = new ThumbnailAgent();
