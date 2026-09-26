// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentOperationSummary } from './AgentOperationSummary';
import type { PublicEditorOperation } from '../../shared/editorOperations';

afterEach(cleanup);
it.each(['e\u0301', '👨‍👩‍👧‍👦', '🏌️'])('字幕抜粋の境界で %s の見た目を壊さない', (character) => {
  const text = 'あ'.repeat(63) + character;
  const operation: PublicEditorOperation = {
    schemaVersion: 1, runId: 'run', serverInstance: 'server', createdAt: 1, updatedAt: 1,
    phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true },
    sessionId: null, humanReview: 'pending', lateResult: null,
    result: { phase: 'saved', revision: 'saved', code: null, applied: true, saved: true },
    request: { schemaVersion: 1, operationId: 'operation', projectId: 'video', baseRevision: 'before',
      changes: [{ type: 'set_telop_text', elementId: 'caption', before: 'before', after: text + '続き',
        sourceFrameRange: { start: 0, end: 30 } }] },
  };
  const { container } = render(<AgentOperationSummary operation={operation} executionLabel="保存済み" />);
  expect(container.querySelector('.agent-operation-excerpt')?.textContent).toBe('変更案 ' + text + '…');
});
