import type { IncomingHttpHeaders } from 'node:http';
import { EDITOR_RUN_HEADER, EDITOR_TOKEN_HEADER } from '../shared/editorDeliveryGuard';
import { EditorAgentService } from './editorAgentService';
import { HttpError } from './http';
import type { EditorChangeSet } from '../shared/editorCommands';

/** A native effect is authorized by the same durable delivery that the browser claimed. */
export function assertEditorDeliveryMayApply(headers:IncomingHttpHeaders,projectId:string,request:EditorChangeSet,service?:EditorAgentService):void {
  if(!service) throw new HttpError(503,'EDITOR_SERVICE_UNAVAILABLE: AI編集の接続を確認できません');
  const run=headers[EDITOR_RUN_HEADER.toLowerCase()],token=headers[EDITOR_TOKEN_HEADER.toLowerCase()];
  try {
    if(typeof run!=='string' || typeof token!=='string' || !run || !token) throw new Error('INVALID_GUARD');
    service.sessions.expire();
    const operation=service.operations.get(run);
    if(operation.serverInstance!==service.operations.serverInstance || operation.claim?.token!==token || operation.cancelRequested
      || !['running','applied'].includes(operation.phase) || operation.request.projectId!==projectId
      || JSON.stringify(operation.request)!==JSON.stringify(request)) throw new Error('DELIVERY_FENCED');
    const snapshot=service.sessions.snapshot(operation.claim.sessionId);
    if(snapshot.status!=='ready' || snapshot.projectId!==projectId) throw new Error('EDITOR_CHANGED');
  } catch { throw new HttpError(423,'DELIVERY_FENCED: このAI編集の反映は停止しました'); }
}

/** Call after reading/validating the request body, immediately before the existing synchronous disk save. */
export function assertEditorDeliveryMaySave(headers: IncomingHttpHeaders, projectId: string, service?: EditorAgentService, expectedResultRevision?:string): void {
  const runId = headers[EDITOR_RUN_HEADER.toLowerCase()];
  const token = headers[EDITOR_TOKEN_HEADER.toLowerCase()];
  if (runId === undefined && token === undefined) return; // Human saves keep the existing contract.
  if (typeof runId !== 'string' || !runId || runId.length > 256 || typeof token !== 'string' || !token || token.length > 256) {
    throw new HttpError(400, 'INVALID_DELIVERY_GUARD: 実行の確認情報が不足しています');
  }
  if (!service) throw new HttpError(503, 'EDITOR_SERVICE_UNAVAILABLE: AI編集の接続を確認できません');
  try {
    service.sessions.expire();
    const operation = service.operations.get(runId);
    if (operation.request.projectId !== projectId || operation.serverInstance !== service.operations.serverInstance
      || operation.claim?.token !== token || operation.phase !== 'applied' || operation.cancelRequested
      || (expectedResultRevision!==undefined && operation.result?.revision!==expectedResultRevision)) {
      throw new Error('DELIVERY_FENCED');
    }
    const snapshot = service.sessions.snapshot(operation.claim.sessionId);
    if (snapshot.status !== 'ready' || snapshot.projectId !== projectId) throw new Error('EDITOR_CHANGED');
  } catch {
    throw new HttpError(423, 'DELIVERY_FENCED: このAI編集の保存は停止しました。現在の内容と実行結果を確認してください');
  }
}
