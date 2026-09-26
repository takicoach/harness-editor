import { expect, it } from 'vitest';
import { editorSessionPresence } from './useEditorAgentConnection';

it('案件読込中・読込失敗・ホームを本文なしのpresenceとして区別する', () => {
  expect(editorSessionPresence(null, 'video', false)).toEqual({ status: 'loading', projectId: 'video' });
  expect(editorSessionPresence(null, 'video', true)).toEqual({ status: 'error', projectId: 'video' });
  expect(editorSessionPresence(null, null, true)).toEqual({ status: 'home', projectId: null });
});
