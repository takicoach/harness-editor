export type EditorAgentRecoveryAction = 'retry_same_request' | 'fix_request' | 'read_current_state'
  | 'wait_then_revalidate' | 'open_editor' | 'inspect_run' | 'reconcile_result'
  | 'use_current_session' | 'contact_operator';

export interface EditorAgentRecovery {
  action: EditorAgentRecoveryAction;
  message: string;
}

export interface EditorAgentErrorDetail {
  error: string;
  code: string;
  retryable: boolean;
  recovery: EditorAgentRecovery;
}

export interface EditorAgentIdentifiers {
  projectId?: string;
  sessionId?: string;
  operationId?: string;
  runId?: string;
}

export type PublicEditorAgentError = EditorAgentErrorDetail & { identifiers?: EditorAgentIdentifiers };

interface ErrorRule {
  action: EditorAgentRecoveryAction;
  message: string;
  retryable?: true;
  status?: number;
}

const RETRY_LOCK = '少し待ってから、同じ要求をそのまま再送してください。';
const FIX_INPUT = '入力を修正し、現在の状態で再検証してください。';
const READ_STATE = 'editor_readで現在の版と内容を取得し、変更案を作り直して再検証してください。';
const WAIT_STATE = '人の操作または進行中の処理が終わるのを待ち、現在の状態を取得して再検証してください。';
const OPEN_EDITOR = '対象案件を編集画面で開き、接続完了後に現在の状態を取得してください。';
const INSPECT_RUN = 'editor_runsで対象の実行結果を確認し、現在の状態に合わせて次の操作を選んでください。';
const RECONCILE = 'editor_runsと編集画面の保存内容を確認し、人が結果を確定してから再開してください。';
const CURRENT_SESSION = 'editor_projectsで現在の接続を取得し、そのsessionIdで状態を読み直してください。';
const OPERATOR = '同じ要求を自動再送せず、エディタの状態とローカルサーバーのログを確認してください。';

/** Only codes emitted by the typed editor boundary may retain their public message. */
const RULES: Readonly<Record<string, ErrorRule>> = {
  INVALID_EDITOR_INPUT: { action: 'fix_request', message: FIX_INPUT, status: 400 },
  INVALID_PAGE: { action: 'fix_request', message: FIX_INPUT, status: 400 },
  INVALID_RULE_REFERENCE: { action: 'fix_request', message: FIX_INPUT, status: 400 },
  INVALID_DELIVERY_GUARD: { action: 'fix_request', message: FIX_INPUT, status: 400 },
  EDITOR_ROUTE_NOT_FOUND: { action: 'fix_request', message: '利用可能なeditor APIまたはMCP操作を確認してください。', status: 404 },
  EDITOR_METHOD_NOT_ALLOWED: { action: 'fix_request', message: 'この操作が受け付けるHTTP methodを確認してください。', status: 405 },
  LOCAL_REQUEST_REQUIRED: { action: 'contact_operator', message: '同じ端末のローカル接続から実行してください。', status: 403 },
  STORE_BUSY: { action: 'retry_same_request', message: RETRY_LOCK, retryable: true, status: 503 },
  EDITOR_SERVICE_UNAVAILABLE: { action: 'retry_same_request', message: 'ローカルサーバーの準備完了後、同じ要求を再送してください。', retryable: true, status: 503 },
  CONTEXT_UNAVAILABLE: { action: 'contact_operator', message: OPERATOR, status: 503 },
  EDITOR_OFFLINE: { action: 'open_editor', message: OPEN_EDITOR, status: 404 },
  EDITOR_NOT_READY: { action: 'open_editor', message: OPEN_EDITOR },
  EDITOR_UNAVAILABLE: { action: 'open_editor', message: OPEN_EDITOR },
  NATIVE_EDITOR_REQUIRED: { action:'open_editor',message:'独自編集の案件を開き、editor_readで現在の編集画面を選んでください。' },
  NO_CHANGE: { action:'fix_request',message:'現在の編集内容を確認し、実際に変更する操作を指定してください。',status:400 },
  PROJECT_NOT_FOUND: { action: 'fix_request', message: 'editor_projectsで案件IDを確認してください。', status: 404 },
  RULE_NOT_FOUND: { action: 'fix_request', message: 'editor_preferencesで現在利用できるルールを確認してください。', status: 404 },
  RUN_NOT_FOUND: { action: 'inspect_run', message: 'editor_runsで現在参照できるrunIdを確認してください。', status: 404 },
  SESSION_INVALID: { action: 'use_current_session', message: CURRENT_SESSION },
  STALE_HEARTBEAT: { action: 'use_current_session', message: CURRENT_SESSION },
  SESSION_OWNERSHIP_CONFLICT: { action: 'use_current_session', message: CURRENT_SESSION },
  HEARTBEAT_CONFLICT: { action: 'use_current_session', message: CURRENT_SESSION },
  CLAIM_MISMATCH: { action: 'use_current_session', message: CURRENT_SESSION },
  MCP_SESSION_EXPIRED: { action: 'use_current_session', message: 'MCP接続を初期化し直してから、現在の状態を取得してください。', status: 404 },
  MCP_SESSION_REQUIRED: { action: 'use_current_session', message: 'MCP接続をinitializeしてから操作を実行してください。', status: 400 },
  HUMAN_BUSY: { action: 'wait_then_revalidate', message: WAIT_STATE },
  UNSAVED_CHANGES: { action: 'wait_then_revalidate', message: WAIT_STATE },
  SAVE_IN_PROGRESS: { action: 'wait_then_revalidate', message: WAIT_STATE },
  PROJECT_BUSY: { action: 'wait_then_revalidate', message: `${INSPECT_RUN} ${WAIT_STATE}` },
  REVISION_CONFLICT: { action: 'read_current_state', message: READ_STATE },
  SOURCE_REFERENCE_REQUIRED: { action:'read_current_state',message:'editor_readのreferenceを変更案へそのまま含め、素材と使用箇所を指定してください。' },
  SOURCE_REFERENCE_CONFLICT: { action:'read_current_state',message:READ_STATE },
  SOURCE_OCCURRENCE_UNAVAILABLE: { action:'read_current_state',message:'対象の原音が有効か編集画面で確認し、現在の状態を取得してください。' },
  AMBIGUOUS_SOURCE_OCCURRENCE: { action:'read_current_state',message:'対象の素材・使用箇所をeditor_readで確認し、referenceを明示してください。' },
  NATIVE_SCRIPT_REVIEW_REQUIRED: { action:'inspect_run',message:'独自編集画面の台本採用は現在未対応です。既存の採用記録を別の編集操作へ読み替えないでください。' },
  CONTENT_CONFLICT: { action: 'read_current_state', message: READ_STATE },
  RANGE_CONFLICT: { action: 'read_current_state', message: READ_STATE },
  TARGET_NOT_FOUND: { action: 'read_current_state', message: READ_STATE },
  PROJECT_MISMATCH: { action: 'read_current_state', message: '対象案件を開き、editor_readで現在の状態を取得してください。' },
  SAVED_STATE_MISMATCH: { action: 'read_current_state', message: READ_STATE },
  OPERATION_CONFLICT: { action: 'inspect_run', message: `${INSPECT_RUN} 別の内容には新しいoperationIdを使用してください。` },
  RECONCILIATION_REQUIRED: { action: 'reconcile_result', message: RECONCILE },
  SAVE_RESULT_UNKNOWN: { action: 'reconcile_result', message: RECONCILE },
  RESULT_UNKNOWN: { action: 'reconcile_result', message: RECONCILE },
  REVIEW_NOT_REQUIRED: { action: 'inspect_run', message: INSPECT_RUN },
  REVIEW_UNAVAILABLE: { action: 'contact_operator', message: OPERATOR },
  REVIEW_CONFLICT: { action: 'inspect_run', message: INSPECT_RUN },
  REVIEW_STALE: { action: 'read_current_state', message: READ_STATE },
  REVIEW_TARGET_CHANGED: { action: 'read_current_state', message: READ_STATE },
  REVIEW_TARGET_MISSING: { action: 'read_current_state', message: READ_STATE },
  LATE_RESULT_CONFLICT: { action: 'reconcile_result', message: RECONCILE },
  CHECKPOINT_CONFLICT: { action: 'inspect_run', message: INSPECT_RUN },
  RESULT_REGRESSION: { action: 'inspect_run', message: INSPECT_RUN },
  RUN_FINISHED: { action: 'inspect_run', message: INSPECT_RUN },
  NOT_CLAIMABLE: { action: 'inspect_run', message: INSPECT_RUN },
  APPLY_UNCONFIRMED: { action: 'inspect_run', message: INSPECT_RUN },
  JOURNAL_INVALID: { action: 'contact_operator', message: OPERATOR },
  SAVE_FAILED: { action: 'inspect_run', message: `${INSPECT_RUN} 保存を自動で再実行しないでください。` },
  EDITOR_OPERATION_FAILED: { action: 'inspect_run', message: INSPECT_RUN },
  EDITOR_OPERATION_CANCELLED: { action: 'inspect_run', message: INSPECT_RUN },
  EDIT_CHANGED_BEFORE_SAVE: { action: 'read_current_state', message: READ_STATE },
  CANCELLED_BEFORE_START: { action: 'inspect_run', message: INSPECT_RUN },
  CANCELLED_BEFORE_APPLY: { action: 'inspect_run', message: INSPECT_RUN },
  CANCELLED_AFTER_APPLY: { action: 'inspect_run', message: `${INSPECT_RUN} 適用済みの内容は必要に応じて人がUndoしてください。` },
};

const INTERNAL_ERROR = 'AI編集の処理に失敗しました';
const SENSITIVE = /(?:\/Users\/|\\Users\\|sessionKey\s*[=:]|(?:access[_-]?)?token\s*[=:]|secret\s*[=:])/i;

function errorCode(message: string): string | null {
  const candidate = /^([A-Z][A-Z0-9_]{1,63})(?::(?:\s|$)|$)/.exec(message)?.[1];
  return candidate && RULES[candidate] ? candidate : null;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

export function editorAgentIdentifiers(input: EditorAgentIdentifiers): EditorAgentIdentifiers | undefined {
  const safe = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    const identifier = safeIdentifier(value);
    return identifier === undefined ? [] : [[key, identifier]];
  })) as EditorAgentIdentifiers;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Pick public IDs from HTTP/MCP input without ever copying credentials or delivery tokens. */
export function editorAgentRequestIdentifiers(input: unknown): EditorAgentIdentifiers {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const identifiers: EditorAgentIdentifiers = {};
  for (const key of ['projectId', 'sessionId', 'operationId', 'runId'] as const) {
    if (typeof record[key] === 'string') identifiers[key] = record[key];
  }
  const nested = editorAgentRequestIdentifiers(record.request);
  Object.assign(identifiers, nested);
  if (record.snapshot && typeof record.snapshot === 'object') {
    const projectId = (record.snapshot as Record<string, unknown>).projectId;
    if (typeof projectId === 'string') identifiers.projectId = projectId;
  }
  return editorAgentIdentifiers(identifiers) ?? {};
}

export function publicEditorAgentError(error: unknown, identifiers: EditorAgentIdentifiers = {}, forcedCode?: string): PublicEditorAgentError {
  const raw = error instanceof Error ? error.message : String(error);
  const code = forcedCode && RULES[forcedCode] ? forcedCode : errorCode(raw);
  const safeIds = editorAgentIdentifiers(identifiers);
  if (!code) return { error: INTERNAL_ERROR, code: 'INTERNAL_EDITOR_ERROR', retryable: false,
    recovery: { action: 'contact_operator', message: OPERATOR }, ...(safeIds ? { identifiers: safeIds } : {}) };
  const rule = RULES[code]!;
  const safeError = SENSITIVE.test(raw) ? `${code}: AI編集の処理を完了できませんでした` : raw;
  return { error: safeError, code, retryable: rule.retryable === true,
    recovery: { action: rule.action, message: rule.message }, ...(safeIds ? { identifiers: safeIds } : {}) };
}

export function editorAgentErrorDetail(code: string): EditorAgentErrorDetail {
  const detail = publicEditorAgentError(`${code}: AI編集の実行を完了できませんでした`);
  const { identifiers: _identifiers, ...withoutIdentifiers } = detail;
  return withoutIdentifiers;
}

export function editorAgentHttpStatus(detail: Pick<EditorAgentErrorDetail, 'code'>): number {
  return RULES[detail.code]?.status ?? (detail.code === 'INTERNAL_EDITOR_ERROR' ? 500 : 409);
}
