import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { editorChangeSetSchema } from '../shared/editorCommands';
import { editorAgentHttpStatus, editorAgentRequestIdentifiers, publicEditorAgentError, type EditorAgentIdentifiers } from '../shared/editorAgentErrors';
import { editorOperationResultSchema } from '../shared/editorOperations';
import { editorOperationActivityPage } from '../shared/editorActivity';
import { EditorAgentService } from './editorAgentService';
import { HttpError, sendJson } from './http';
import { isAllowedLocalRequest } from './localGuard';
import { readJsonBody } from './readBody';
import {NATIVE_EDITOR_COMMAND_TYPES} from '../shared/nativeEditorCommands';

const id = z.string().min(1).max(256);
const credentials = z.object({ sessionId: id, sessionKey: z.string().min(32).max(256) }).strict();
const change = z.object({ sessionId: id, request: editorChangeSetSchema }).strict();
const run = z.object({ runId: id }).strict();

class EditorEndpointError extends HttpError {
  constructor(status: number, message: string, readonly publicCode: string) { super(status, message); }
}

/** Keep HTTP status semantics while sharing the public body with MCP tool failures. */
export function sendEditorAgentError(res: ServerResponse, error: unknown,
  identifiers: EditorAgentIdentifiers = {}, forcedCode?: string): void {
  const normalized = error instanceof z.ZodError
    ? new Error(`INVALID_EDITOR_INPUT: ${error.issues.map((issue) => issue.message).join(' / ')}`) : error;
  const code = forcedCode ?? (error instanceof EditorEndpointError ? error.publicCode : undefined);
  const body = publicEditorAgentError(normalized, identifiers, code);
  const status = error instanceof HttpError ? error.status : editorAgentHttpStatus(body);
  if (status >= 500) console.error('[sme] AI編集APIエラー:', error);
  sendJson(res, status, body);
}

export const EDITOR_AGENT_CAPABILITIES = {
  schemaVersion: 1, operations: ['set_telop_text'],
  native:{documentFormat:'sequence-v2',operations:NATIVE_EDITOR_COMMAND_TYPES,maxCommandsPerOperation:50,
    readSections:['clips','assets','tracks','cuts','transcripts'],requiresCurrentRevision:true},
  requiresOpenEditor: true, maxChangesPerOperation: 100, maxSnapshotPageSize: 100,
  undo: 'one_existing_editor_history_entry', save: 'exact_applied_state_without_overwrite',
  review: 'human_review_separate_from_execution',
  discovery: ['projects', 'project_preferences', 'consented_rule_examples'],
  unavailable: ['headless_editing', 'arbitrary_code', 'automatic_preference_activation'],
} as const;

export async function handleEditorAgentApi(req: IncomingMessage, res: ServerResponse, url: URL, service: EditorAgentService): Promise<void> {
  const identifiers: EditorAgentIdentifiers = {};
  for (const key of ['projectId', 'sessionId', 'operationId', 'runId'] as const) {
    const value = url.searchParams.get(key); if (value !== null) identifiers[key] = value;
  }
  try {
    if (!isAllowedLocalRequest(req.headers)) throw new HttpError(403, 'LOCAL_REQUEST_REQUIRED');
    const method = (req.method ?? 'GET').toUpperCase();
    const route = url.pathname;
    if (method === 'GET') {
      if (route === '/api/editor/capabilities') { sendJson(res, 200, EDITOR_AGENT_CAPABILITIES); return; }
      if (route === '/api/editor/sessions') { sendJson(res, 200, { sessions: service.sessions.list() }); return; }
      if (route === '/api/editor/projects') {
        sendJson(res, 200, service.projects(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 20))); return;
      }
      if (route === '/api/editor/board') {
        sendJson(res, 200, service.board(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 20))); return;
      }
      if (route === '/api/editor/preferences') {
        const ruleId = url.searchParams.get('ruleId');
        const version = url.searchParams.get('version');
        sendJson(res, 200, service.preferences(id.parse(url.searchParams.get('projectId')), {
          offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 20),
          ruleId: ruleId === null ? undefined : id.parse(ruleId), version: version === null ? undefined : Number(version),
        })); return;
      }
      if (route === '/api/editor/snapshot') {
        const sessionId = id.parse(url.searchParams.get('sessionId'));
        const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??100),section=url.searchParams.get('section');
        sendJson(res, 200, section?service.readNative(sessionId,{section:z.enum(['clips','assets','tracks','cuts','transcripts']).parse(section),offset,limit,
          revision:url.searchParams.get('revision')??undefined}):service.read(sessionId,offset,limit));
        return;
      }
      if (route === '/api/editor/operations') {
        const projectId = url.searchParams.get('projectId');
        const operations = service.list(projectId === null ? undefined : id.parse(projectId));
        const rawOffset = url.searchParams.get('offset');
        sendJson(res, 200, editorOperationActivityPage(operations,
          rawOffset === null ? undefined : Number(rawOffset), Number(url.searchParams.get('limit') ?? 20))); return;
      }
      if (route === '/api/editor/operation') {
        if (url.searchParams.has('operationId')) {
          const operationId = id.parse(url.searchParams.get('operationId'));
          const projectId = id.parse(url.searchParams.get('projectId'));
          const operation = service.list(projectId).find(item => item.request.operationId === operationId);
          if (!operation) throw new EditorEndpointError(404, '指定された編集操作はまだ記録されていません', 'OPERATION_NOT_FOUND');
          sendJson(res, 200, operation); return;
        }
        sendJson(res, 200, service.get(id.parse(url.searchParams.get('runId')))); return;
      }
      throw new EditorEndpointError(404, '編集操作が見つかりません', 'EDITOR_ROUTE_NOT_FOUND');
    }
    if (method !== 'POST') throw new EditorEndpointError(405, 'この編集操作はGETまたはPOSTで実行してください', 'EDITOR_METHOD_NOT_ALLOWED');
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch (error) {
      // Only the body reader's known 400/413 failures are input errors. A later backend HttpError
      // must keep its own code/status and must not be mislabeled as caller-correctable input.
      if (error instanceof HttpError && (error.status === 400 || error.status === 413)) {
        throw new EditorEndpointError(error.status, error.message, 'INVALID_EDITOR_INPUT');
      }
      throw error;
    }
    Object.assign(identifiers, editorAgentRequestIdentifiers(body));
    if (route === '/api/editor/heartbeat') { sendJson(res, 200, service.heartbeat(body)); return; }
    if (route === '/api/editor/validate' || route === '/api/editor/operations') {
      const input = change.parse(body);
      const receipt = route.endsWith('/validate') ? service.validate(input.sessionId, input.request) : service.enqueue(input.sessionId, input.request);
      sendJson(res, route.endsWith('/validate') ? 200 : 202, receipt); return;
    }
    if (route === '/api/editor/cancel') { sendJson(res, 200, service.cancel(run.parse(body).runId)); return; }
    if (route === '/api/editor/review') {
      const input = credentials.extend({ runId: id }).parse(body);
      service.sessions.authenticate(input.sessionId, input.sessionKey);
      sendJson(res, 200, service.prepareReconciliation(input.sessionId, input.runId)); return;
    }
    if (route === '/api/editor/reconcile') {
      const input = credentials.extend({ runId: id, reviewId: id, snapshotHash: id, confirmedCurrentSavedState: z.literal(true) }).parse(body);
      sendJson(res, 200, service.reconcile(input.sessionId, input.sessionKey, input.runId, input.reviewId, input.snapshotHash,
        process.env.HARNESS_PREFERENCE_TEST_FIXTURE === '1' ? 'synthetic' : 'human')); return;
    }
    if (route === '/api/editor/delivery') {
      const input = credentials.extend({ runId: id }).parse(body);
      sendJson(res, 200, service.delivery(input.sessionId, input.sessionKey, input.runId)); return;
    }
    if (route === '/api/editor/ack') {
      const input = credentials.extend({ runId: id, token: id, result: editorOperationResultSchema }).parse(body);
      sendJson(res, 200, service.acknowledge(input.sessionId, input.sessionKey, input.runId, input.token, input.result)); return;
    }
    if (route === '/api/editor/disconnect') {
      const input = credentials.parse(body); service.disconnect(input.sessionId, input.sessionKey);
      sendJson(res, 200, { disconnected: true }); return;
    }
    throw new EditorEndpointError(404, '編集操作が見つかりません', 'EDITOR_ROUTE_NOT_FOUND');
  } catch (error) {
    sendEditorAgentError(res, error, identifiers);
  }
}
