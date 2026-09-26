/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicEditorOperation } from '../../shared/editorOperations';
import { editorOperationActivityPage } from '../../shared/editorActivity';
import { AgentActivityDialog } from './AgentActivityDialog';

const operation = (index: number): PublicEditorOperation => ({
  schemaVersion: 1, runId: `run-${index}`, serverInstance: 'server', createdAt: index, updatedAt: index,
  phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true }, sessionId: null,
  result: { phase: 'saved', revision: `revision-${index}`, code: null, applied: true, saved: true }, lateResult: null,
  humanReview: index === 0 ? 'pending' : 'reviewed',
  request: { schemaVersion: 1, operationId: `operation-${index}`, projectId: 'video', baseRevision: `base-${index}`,
    changes: [{ type: 'set_telop_text', elementId: '1', before: `before-${index}`, after: `after-${index}`,
      sourceFrameRange: { start: 0, end: 30 } }] },
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const exactParagraph = (text: string) => (_: string, element: Element | null) => element?.tagName === 'P' && element.textContent === text;

describe('AgentActivityDialog history pages', () => {
  it('失敗した古いpageを完了扱いせず再試行でき、最新reset後は大量追記の中間runへ届く', async () => {
    let operations = Array.from({ length: 21 }, (_, index) => operation(index));
    let failOlderOnce = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined;
      if (offset !== undefined && failOlderOnce) {
        failOlderOnce = false;
        return new Response(JSON.stringify({ error: 'TEMPORARY_FAILURE' }), { status: 503 });
      }
      return new Response(JSON.stringify(editorOperationActivityPage(operations, offset)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentActivityDialog projectId="video" credentials={{ sessionId: 'window', sessionKey: 'x'.repeat(32) }}
      connection="connected" connectionError={null} onClose={vi.fn()} onReview={vi.fn()} />);

    await screen.findByText(exactParagraph('変更前：before-20'));
    fireEvent.click(screen.getByRole('button', { name: 'さらに前の履歴を表示' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/前の履歴を読み込めません/);
    expect((screen.getByRole('button', { name: 'さらに前の履歴を表示' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'さらに前の履歴を表示' }));
    expect(await screen.findByText(exactParagraph('変更前：before-0'))).toBeTruthy();
    expect(screen.getByText(/取得時点の内容/)).toBeTruthy();

    operations = Array.from({ length: 51 }, (_, index) => operation(index));
    fireEvent.click(screen.getByRole('button', { name: '最新の履歴に更新' }));
    await screen.findByText(exactParagraph('変更前：before-50'));
    await waitFor(() => expect(screen.queryByText(exactParagraph('変更前：before-0'))).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'さらに前の履歴を表示' }));
    expect(await screen.findByText(exactParagraph('変更前：before-25'))).toBeTruthy();
  });

  it('直して採用した本文を履歴に表示し、変更前の文字を保ったまま差を強調する', async () => {
    const item = operation(1);
    item.request.changes[0] = { ...item.request.changes[0]!, before: '長いアイアソ2本ですね', after: '長いアイアン2本です' };
    item.review = { completed: 1, total: 1, synthetic: true, judgments: [{ id: 'decision', decision: 'accepted_modified', provenance: 'synthetic', recordedText: '長いアイアン2本ですね' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(editorOperationActivityPage([item], undefined)), { status: 200 })));
    render(<AgentActivityDialog projectId="video" credentials={{ sessionId: 'window', sessionKey: 'x'.repeat(32) }} connection="connected" connectionError={null} onClose={vi.fn()} />);
    const before = await screen.findByText(exactParagraph('変更前：長いアイアソ2本ですね'));
    expect(Array.from(before.querySelectorAll('mark'), (mark) => mark.textContent)).toEqual(['ソ', 'ね']);
    expect(Array.from(screen.getByText(exactParagraph('AIの変更案：長いアイアン2本です')).querySelectorAll('mark'), (mark) => mark.textContent)).toEqual(['ン']);
    expect(screen.getByText('判断で残した本文：長いアイアン2本ですね')).toBeTruthy();
    expect(screen.getByText('判断時点の記録です。その後の編集は含みません。')).toBeTruthy();
  });

  it('応答しない初回取得を期限切れにし、手動再試行と閉じる操作を残す', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn(); let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<Response>(() => {});
      return Promise.resolve(new Response(JSON.stringify(editorOperationActivityPage([], undefined)), { status: 200 }));
    }));
    render(<AgentActivityDialog projectId="video" credentials={{ sessionId: 'window', sessionKey: 'x'.repeat(32) }}
      connection="connected" connectionError={null} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'AIの作業を閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.getByRole('alert').textContent).toMatch(/応答がありません/);
    fireEvent.click(screen.getByRole('button', { name: '履歴をもう一度読み込む' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('この動画には、まだAIの編集記録がありません。')).not.toBeNull();
  });
});
