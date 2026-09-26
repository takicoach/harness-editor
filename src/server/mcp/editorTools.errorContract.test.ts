import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EditorAgentService } from '../editorAgentService';
import { registerEditorTools } from './editorTools';

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

function tool(name: string, service: Partial<EditorAgentService>) {
  const handlers = new Map<string, (input: Record<string, unknown>) => ToolResult>();
  const server = { registerTool: vi.fn((registered: string, _definition: unknown,
    handler: (input: Record<string, unknown>) => ToolResult) => handlers.set(registered, handler)) } as unknown as McpServer;
  registerEditorTools(server, service as EditorAgentService);
  return handlers.get(name)!;
}

const request = { schemaVersion: 1, operationId: 'op-1', projectId: 'project-1', baseRevision: 'old',
  changes: [{ type: 'set_telop_text', elementId: 'telop-1', before: 'before', after: 'after',
    sourceFrameRange: { start: 0, end: 30 } }] };

describe('MCP editor tool error contract', () => {
  it('版競合をJSONで返し、同一要求の自動再送を禁止する', () => {
    const apply = tool('editor_apply', { enqueue: vi.fn(() => { throw new Error('REVISION_CONFLICT: 現在の版を取得してください'); }) });
    const result = apply({ sessionId: 'session-1', request });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      error: 'REVISION_CONFLICT: 現在の版を取得してください', code: 'REVISION_CONFLICT', retryable: false,
      recovery: { action: 'read_current_state' },
      identifiers: { projectId: 'project-1', sessionId: 'session-1', operationId: 'op-1' },
    });
  });

  it('STORE_BUSYだけは副作用前の失敗として同一要求の再送を案内する', () => {
    const cancel = tool('editor_cancel', { cancel: vi.fn(() => { throw new Error('STORE_BUSY: 記録を保存中です'); }) });
    const body = JSON.parse(cancel({ runId: 'run-1' }).content[0]!.text);
    expect(body).toMatchObject({ code: 'STORE_BUSY', retryable: true,
      recovery: { action: 'retry_same_request' }, identifiers: { runId: 'run-1' } });
  });

  it('未知例外の内部情報を公開しない', () => {
    const read = tool('editor_read', { read: vi.fn(() => { throw new Error('/private/state.json sessionKey=secret'); }) });
    const result = read({ sessionId: 'session-1' });
    const serialized = result.content[0]!.text;
    expect(JSON.parse(serialized)).toMatchObject({ code: 'INTERNAL_EDITOR_ERROR', retryable: false,
      recovery: { action: 'contact_operator' }, identifiers: { sessionId: 'session-1' } });
    expect(serialized).not.toMatch(/private|secret/);
  });
});
