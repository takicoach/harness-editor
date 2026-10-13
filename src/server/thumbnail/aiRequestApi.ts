import { thumbnailAiButtonSchema, thumbnailAiRequestText, thumbnailAiStatus, THUMBNAIL_AI_STATUS_LABEL, type ThumbnailAiLatest } from '../../shared/thumbnailAi';
import { withRequestNumber } from '../../shared/agentPrompts';
import type { InstructionInbox } from '../instructionInbox';
import { ThumbnailAgentError, type ThumbnailAgent } from './agent';

export interface ThumbnailAiApiDeps {
  agent: ThumbnailAgent; inbox: Pick<InstructionInbox, 'enqueuePasted' | 'updateStatus' | 'list'>;
  running(): boolean; paste(text: string): { ok: true } | { ok: false; error: string }; projectDir(projectId: string): string;
}
export function thumbnailAiLatest(projectId: string, deps: ThumbnailAiApiDeps): ThumbnailAiLatest {
  const request = deps.agent.latest(projectId) ?? null;
  if (!request) return { request: null, status: null, label: null, message: null };
  const inbox = request.route === 'button' ? deps.inbox.list(projectId).find(record => record.id === request.requestId) ?? null : null;
  const { status, message } = thumbnailAiStatus(request, inbox);
  return { request, status, label: THUMBNAIL_AI_STATUS_LABEL[status], message };
}
/** 画面の「AI タブに入れる」。依頼の記録を先に確かめてから受け箱に積み、入力欄に貼る（Enter は利用者）。 */
export function createThumbnailAiButtonRequest(body: unknown, deps: ThumbnailAiApiDeps): { status: number; body: unknown } {
  const parsed = thumbnailAiButtonSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: '依頼の形が正しくありません', code: 'INVALID_INPUT' } };
  const input = parsed.data;
  if (!deps.running()) return { status: 409, body: { error: 'AI が起動していません。AI タブを開いてから、もう一度押してください', code: 'AI_NOT_RUNNING' } };
  let draft: ReturnType<ThumbnailAgent['draft']>;
  try { draft = deps.agent.draft({ projectId: input.projectId, kind: input.kind, pageId: input.pageId, cutout: input.cutout, note: input.note, route: 'button' }); }
  catch (error) {
    if (error instanceof ThumbnailAgentError) return { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409, body: { error: error.message, code: error.code } };
    throw error;
  }
  const text = thumbnailAiRequestText({ kind: input.kind, targetName: draft.targetPageName, cutout: input.cutout, note: input.note });
  const { record, created } = deps.inbox.enqueuePasted({ requestId: input.requestId, requestCreatedAt: input.requestCreatedAt, projectId: input.projectId,
    projectDir: deps.projectDir(input.projectId), text, context: { frame: 0, timeSec: 0, selection: null } });
  // 新しい受け箱の依頼は必ず今の内容で記録を作り直す（受け箱の番号 inst-N は受け箱を作り直すと 1 に戻り、案件側の古い記録と同じ番号になりうる。put は同じ番号を置き換える）。
  // 再送（created=false）は、記録が無い（記録の前に止まった）時だけ作る。
  if (created || !deps.agent.find(input.projectId, record.id)) deps.agent.store(input.projectId, { requestId: record.id, ...draft });
  if (created) {
    const pasted = deps.paste(withRequestNumber(record.text, record.id));
    if (!pasted.ok) { deps.inbox.updateStatus(record.id, 'failed', 'AI の入力欄に貼れませんでした'); return { status: 409, body: { error: pasted.error, code: 'AI_NOT_RUNNING' } }; }
  }
  return { status: 200, body: thumbnailAiLatest(input.projectId, deps) };
}
