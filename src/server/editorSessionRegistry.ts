import { editorSessionHeartbeatSchema, type EditorSessionHeartbeat, type EditorSessionSnapshot, type EditorSessionSummary } from '../shared/editorSessions';

type Session = EditorSessionHeartbeat & { expiresAt: number };
const sameSnapshot = (a: EditorSessionSnapshot, b: EditorSessionSnapshot) => JSON.stringify(a) === JSON.stringify(b);

/** Ephemeral browser presence only. Durable mutation receipts stay in EditorOperationStore.
 * A sessionKey prevents accidental cross-window ownership; localhost remains the application trust boundary.
 */
export class EditorSessionRegistry {
  private readonly sessions = new Map<string, Session>();
  // Keep only the accepted sequence after expiry. Delayed packets cannot resurrect an older snapshot.
  // Browser session IDs are UUIDs; this watermark lasts for the owning server's lifetime.
  private readonly lastSequences = new Map<string, number>();
  constructor(private readonly onDisconnect: (sessionId: string) => void,
    private readonly now = Date.now, private readonly ttlMs = 15000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('INVALID_TTL');
  }
  expire(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= this.now()) {
        // Persist unknown delivery state before making the former owner available for replacement.
        this.onDisconnect(id);
        this.sessions.delete(id);
      }
    }
  }
  heartbeat(input: unknown): EditorSessionSummary {
    const request = editorSessionHeartbeatSchema.parse(input);
    this.expire();
    const current = this.sessions.get(request.sessionId);
    if (!current && request.sequence <= (this.lastSequences.get(request.sessionId) ?? -1)) {
      throw new Error('STALE_HEARTBEAT: 切断前の古い編集状態は復元しません');
    }
    if (current) {
      if (request.sessionKey !== current.sessionKey) throw new Error('SESSION_OWNERSHIP_CONFLICT: 別の編集画面です');
      if (request.sequence < current.sequence) throw new Error('STALE_HEARTBEAT: 古い編集状態は反映しません');
      if (request.sequence === current.sequence && !sameSnapshot(request.snapshot, current.snapshot)) {
        throw new Error('HEARTBEAT_CONFLICT: 同じ番号の状態が一致しません');
      }
      const leavesProject = current.snapshot.projectId !== request.snapshot.projectId
        || (current.snapshot.status === 'ready' && request.snapshot.status !== 'ready');
      // A reload/project switch ends the former UI's ability to prove what happened to its claim.
      // Persist that fence before publishing the new snapshot, even if the browser window stays open.
      if (leavesProject) this.onDisconnect(request.sessionId);
    }
    const session = { ...request, expiresAt: this.now() + this.ttlMs };
    this.sessions.set(request.sessionId, session);
    this.lastSequences.set(request.sessionId, request.sequence);
    return this.summary(session);
  }
  private active(sessionId: string): Session {
    this.expire();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('EDITOR_OFFLINE: 編集画面を開いて接続してください');
    return session;
  }
  authenticate(sessionId: string, sessionKey: string): void {
    if (this.active(sessionId).sessionKey !== sessionKey) throw new Error('SESSION_OWNERSHIP_CONFLICT: 別の編集画面です');
  }
  close(sessionId: string, sessionKey: string): void {
    this.authenticate(sessionId, sessionKey);
    this.onDisconnect(sessionId);
    this.sessions.delete(sessionId);
  }
  list(): EditorSessionSummary[] {
    this.expire();
    return [...this.sessions.values()].map((session) => this.summary(session));
  }
  snapshot(sessionId: string): EditorSessionSnapshot {
    return structuredClone(this.active(sessionId).snapshot);
  }
  private summary(session: Session): EditorSessionSummary {
    const snapshot = session.snapshot;
    return { sessionId: session.sessionId, status: snapshot.status, projectId: snapshot.projectId,
      revision: snapshot.status === 'ready' ? snapshot.revision : null,
      dirty: snapshot.status === 'ready' && snapshot.dirty,
      saving: snapshot.status === 'ready' && snapshot.saving,
      humanBusy: snapshot.status === 'ready' && snapshot.humanBusy,
      elementCount: snapshot.status === 'ready' ? snapshot.elements.length : 0, expiresAt: session.expiresAt };
  }
}
