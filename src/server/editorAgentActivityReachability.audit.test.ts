import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { handleEditorAgentApi } from './editorAgentApi';
import type { EditorAgentService } from './editorAgentService';

it('21件目より古い未確認操作にも公開履歴から到達できる', async () => {
  const operations = Array.from({ length: 21 }, (_, i) => ({
    runId: `run-${i}`, humanReview: i === 0 ? 'pending' : 'reviewed',
    confirmed: { applied: true, saved: true }, request: { projectId: 'video' },
  }));
  const service = { list: () => operations } as unknown as EditorAgentService;
  const server = createServer((req, res) => {
    void handleEditorAgentApi(req, res, new URL(req.url!, 'http://localhost'), service);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}/api/editor/operations?projectId=video`;
    const page = await (await fetch(base)).json();
    const reached = [...page.operations];
    if (typeof page.nextOffset === 'number') {
      const next = await (await fetch(`${base}&offset=${page.nextOffset}`)).json();
      reached.push(...next.operations);
    }
    expect(reached.some((operation: { runId: string }) => operation.runId === 'run-0'),
      'Board counts the pending run, but history omits it and supplies no next page').toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
