import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PublicEditorOperation } from '../../shared/editorOperations';
import type { EditorAgentService } from '../editorAgentService';
import { registerEditorTools } from './editorTools';

describe('editor_runs pagination', () => {
  it('MCPから古い未確認runへ到達し、runId指定は従来どおり正確な1件を返す', () => {
    const operations = Array.from({ length: 21 }, (_, index) => ({
      runId: `run-${index}`, humanReview: index === 0 ? 'pending' : 'reviewed',
    })) as PublicEditorOperation[];
    const handlers = new Map<string, (input: Record<string, unknown>) => { content: Array<{ text: string }> }>();
    const definitions = new Map<string, { inputSchema: Record<string, { description?: string }> }>();
    const server = { registerTool: vi.fn((name: string, definition: { inputSchema: Record<string, { description?: string }> }, handler: (input: Record<string, unknown>) => { content: Array<{ text: string }> }) => {
      definitions.set(name, definition);
      handlers.set(name, handler);
    }) } as unknown as McpServer;
    const service = { list: vi.fn(() => operations), get: vi.fn((runId: string) => ({ runId })) } as unknown as EditorAgentService;
    registerEditorTools(server, service);
    const runs = handlers.get('editor_runs')!;
    expect(definitions.get('editor_runs')?.inputSchema.offset?.description).toMatch(/初回.*0.*nextOffset.*null.*終端/);

    const first = JSON.parse(runs({ projectId: 'video' }).content[0]!.text) as { operations: PublicEditorOperation[]; nextOffset: number | null };
    expect(first.operations).toHaveLength(20); expect(first.nextOffset).toBe(1);
    const explicitFirst = JSON.parse(runs({ projectId: 'video', offset: 0, limit: 20 }).content[0]!.text) as {
      operations: PublicEditorOperation[]; nextOffset: number | null;
    };
    expect(explicitFirst).toEqual(first);
    const older = JSON.parse(runs({ projectId: 'video', offset: first.nextOffset }).content[0]!.text) as { operations: PublicEditorOperation[] };
    expect(older.operations.map((operation) => operation.runId)).toEqual(['run-0']);
    expect(JSON.parse(runs({ runId: 'run-0' }).content[0]!.text)).toEqual({ runId: 'run-0' });
  });
});
