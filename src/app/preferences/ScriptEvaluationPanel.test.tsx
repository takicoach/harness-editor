// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptEvaluationPanel } from './ScriptEvaluationPanel';
import { ScriptModelComparisonPanel } from './ScriptModelComparisonPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const dataset = { schemaVersion: 1, id: 'dataset', version: 1, frozenAt: '2026-09-08T00:00:00Z',
  rubricVersion: 'script-plan-v1', labelSource: 'synthetic', cases: [{ judgmentId: 'one' }], hash: 'a'.repeat(64) } as never;
const item = { judgmentId: 'one', kind: 'caption', decision: 'accepted', labelSource: 'synthetic', projectId: 'project', available: true, reasons: [] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
describe('script evaluation selection and recovery', () => {
  it('shows unavailable reasons and freezes only the selected eligible reference through the existing journal command', async () => {
    const execute = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/script-evaluation')) return response({ cases: [item, { ...item, judgmentId: 'two', decision: 'deferred', available: false, reasons: ['DEFERRED'] }], datasets: [], syntheticWorkspace: true });
      if (url.endsWith('/script-dataset-prepare')) {
        expect(JSON.parse(String(init?.body)).caseIds).toEqual(['one']); return response({ dataset });
      }
      throw new Error(`unexpected ${url}`);
    }));
    render(<ScriptEvaluationPanel workspace={{ state: { decisions: { events: [] }, operations: [] }, execute } as never} disabled={false} />);
    await screen.findByText(/判断を保留しています/);
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[1]!.disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: '選んだ1件の台本判断を固定' }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'script_dataset', dataset })));
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not keep an eligible selection after a failed refresh', async () => {
    let failed = false;
    vi.stubGlobal('fetch', vi.fn(async () => failed ? response({ error: 'read failed' }, 503) : response({ cases: [item], datasets: [], syntheticWorkspace: true })));
    render(<ScriptEvaluationPanel workspace={{ state: { decisions: { events: [] }, operations: [] } } as never} disabled={false} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    failed = true; fireEvent.click(screen.getByRole('button', { name: '台本の記録を読み直す' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: '選んだ1件の台本判断を固定' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('rejects malformed files and removes the prior output before another comparison', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ schemaVersion: 1, inputHash: 'a'.repeat(64),
      input: { cases: [{ caseId: 'case', kind: 'caption', input: {}, target: {} }] }, rubricVersion: 'script-plan-v1', humanCalibrationStatus: 'not_calibrated' })));
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:fixture'; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ScriptModelComparisonPanel dataset={dataset} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '台本比較の共通入力を書き出す' }));
    const input = await screen.findByLabelText('出力 A のJSONファイル');
    const valid = { name: 'valid.json', size: 2, text: async () => '{}' };
    fireEvent.change(input, { target: { files: [valid] } });
    await screen.findByText('valid.json');
    fireEvent.change(input, { target: { files: [{ ...valid, name: 'broken.json', text: async () => 'invalid json' }] } });
    await screen.findByRole('alert');
    expect(screen.queryByText('valid.json')).toBeNull();
    expect((screen.getByRole('button', { name: '台本の2つの出力を比較' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
