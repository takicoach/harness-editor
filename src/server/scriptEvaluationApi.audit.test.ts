import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { scriptApplicationRequest } from '../app/edit/scriptAdoption';
import { freezeScriptDataset } from '../learning/scriptEvaluation';
import { PreferenceWorkspaceStore } from '../learning/preferenceWorkspaceStore';
import { EditorOperationStore } from './editorOperationStore';
import { handlePreferenceApi } from './preferenceApi';
import { HttpError, sendJson } from './http';

describe('script evaluation request snapshot audit', () => {
  let directory: string;
  let root: string;
  let store: PreferenceWorkspaceStore;
  let server: Server;
  let requestStarted: (() => void) | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'script-evaluation-audit-'));
    root = join(directory, 'projects');
    mkdirSync(join(root, 'project'), { recursive: true });
    store = new PreferenceWorkspaceStore(join(directory, 'learning'));
    server = createServer((req, res) => {
      requestStarted?.();
      void handlePreferenceApi(req, res, new URL(req.url!, 'http://localhost'), root, store)
        .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof Error ? error.message : String(error) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  it('rechecks withdrawal after a slow POST body instead of using the pre-body snapshot', async () => {
    const event = {
      ...scriptJudgmentFixture(),
      learningConsent: true,
      provenance: { kind: 'human' as const },
      artifact: scriptAdoptionFixture('caption'),
    };
    store.execute({ kind: 'decision', operationId: event.operationId, at: event.createdAt,
      actor: event.actor, event });

    const operationStore = new EditorOperationStore(join(root, '.sme-editor-operations.json'), 'audit');
    const queued = operationStore.enqueue(scriptApplicationRequest(event, 'reloaded-revision'));
    const claimed = operationStore.claim(queued.runId, 'reloaded-browser');
    operationStore.acknowledge(claimed.runId, claimed.claim!.sessionId, claimed.claim!.token,
      { phase: 'applied', revision: 'after', code: null, applied: true, saved: false });
    operationStore.acknowledge(claimed.runId, claimed.claim!.sessionId, claimed.claim!.token,
      { phase: 'saved', revision: 'after', code: null, applied: true, saved: true });

    const dataset = freezeScriptDataset(store.read().decisions, operationStore.list(), {
      id: 'dataset', version: 1, frozenAt: '2026-09-08T00:01:00Z', caseIds: [event.id],
    });
    store.execute({ kind: 'script_dataset', operationId: 'freeze', at: '2026-09-08T00:01:00Z',
      actor: event.actor, dataset });

    const handlerStarted = new Promise<void>(resolve => { requestStarted = resolve; });

    const body = JSON.stringify({ datasetId: 'dataset', datasetVersion: 1 });
    const port = (server.address() as { port: number }).port;
    const response = new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { received += chunk; });
      socket.on('error', reject);
      socket.on('end', () => resolve(received));
      socket.on('connect', () => {
        socket.write(`POST /api/preferences/script-model-input HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 8)}`);
      });
      void handlerStarted.then(() => {
        store.execute({ kind: 'decision', operationId: 'withdraw', at: '2026-09-08T00:02:00Z',
          actor: event.actor, event: { schemaVersion: 1, type: 'withdrawal', id: 'withdraw',
            operationId: 'withdraw', createdAt: '2026-09-08T00:02:00Z', actor: event.actor,
            targetId: event.id, reason: 'audit concurrent withdrawal' } });
        socket.end(body.slice(8));
      });
    });

    expect(await response).toMatch(/^HTTP\/1\.1 409 /);
  });
});
