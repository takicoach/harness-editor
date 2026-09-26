// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ModelComparisonPanel } from './ModelComparisonPanel';
import { putJsonPost } from '../fetchJson';
vi.mock('../fetchJson', () => ({ putJsonPost: vi.fn() }));
const post = vi.mocked(putJsonPost);
const selection = { ruleId: 'r', ruleVersion: 1, datasetId: 'd', datasetVersion: 1 };
const prepared = { input: { cases: [] }, inputHash: 'same-input', humanCalibrationStatus: 'not_calibrated' };
const output = { schemaVersion: 1, predictions: [] };
const report = { model: 'モデルA', status: 'completed', humanCalibrationStatus: 'not_calibrated', failures: ['HUMAN_LABELS_REQUIRED'],
  aggregate: { passed: 10, falsePass: 0, falseFail: 0, unjudged: 0, ruleViolations: 0 } };
const comparison = { createdAt: '2026-09-07T00:00:00Z', prepared, reports: [report, { ...report, model: 'モデルB' }] };
beforeEach(() => {
  post.mockReset();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function file(name = 'model.json', text = JSON.stringify(output)) {
  const value = new File([text], name, { type: 'application/json' });
  Object.defineProperty(value, 'text', { value: async () => text }); return value;
}
async function start() {
  const view = render(<ModelComparisonPanel selection={selection} disabled={false} />);
  post.mockResolvedValueOnce(prepared);
  fireEvent.click(view.getByText('共通の入力を書き出す'));
  await waitFor(() => expect(view.queryByLabelText('結果1の出力ファイル')).not.toBeNull());
  return view;
}
async function choose(view: ReturnType<typeof render>, index: number, value = file()) {
  fireEvent.change(view.getByLabelText(`結果${index}の出力ファイル`), { target: { files: [value] } });
  await waitFor(() => expect(view.queryByText('確認しています…')).toBeNull());
}
describe('モデル比較のファイル操作', () => {
  it('同じ入力の2出力を送信し、未較正・再評価を明示する', async () => {
    const view = await start(); await choose(view, 1); await choose(view, 2, file('second.json'));
    post.mockResolvedValueOnce(comparison);
    fireEvent.click(view.getByText('2つの出力を同じ基準で比較'));
    await waitFor(() => expect(view.queryByRole('table')).not.toBeNull());
    expect(post).toHaveBeenLastCalledWith('/api/preferences/model-compare', { ...selection, inputHash: 'same-input',
      outputs: [{ label: 'モデルA', output }, { label: 'モデルB', output }] });
    expect(view.getByText('保存済み出力の再評価')).toBeTruthy();
    expect(view.getByText(/人が判断した実例が不足/)).toBeTruthy();
    fireEvent.change(view.getByLabelText('結果1のモデル名と版'), { target: { value: '新しい名前' } });
    expect(view.queryByRole('table')).toBeNull();
  });
  it('壊れたファイルへ変更したら前ファイルを使って比較しない', async () => {
    const view = await start(); await choose(view, 1); await choose(view, 2);
    await choose(view, 1, file('broken.json', '{'));
    expect(view.getByRole('alert').textContent).toContain('JSON形式');
    expect((view.getByText('2つの出力を同じ基準で比較') as HTMLButtonElement).disabled).toBe(true);
  });
  it('別の評価データへ移った後に古い返事を表示しない', async () => {
    const view = await start(); await choose(view, 1); await choose(view, 2);
    let resolve!: (value: unknown) => void;
    post.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    fireEvent.click(view.getByText('2つの出力を同じ基準で比較'));
    view.rerender(<ModelComparisonPanel key="different-dataset" selection={{ ...selection, datasetId: 'other' }} disabled={false} />);
    resolve(comparison);
    await waitFor(() => expect(view.queryByText('確認しています…')).toBeNull());
    expect(view.queryByRole('table')).toBeNull();
    expect(view.queryByLabelText('結果1の出力ファイル')).toBeNull();
  });
});
