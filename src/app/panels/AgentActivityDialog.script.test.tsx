/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptAdoptionFixture } from '../../core/__fixtures__/scriptAdoption';
import { AgentActivityDialog } from './AgentActivityDialog';
import { isAgentEditBlocked, isModalOpen } from '../isModalOpen';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('script activity saved-state review', () => {
  it.each(['caption', 'structure'] as const)('%s shows actual saved script content before confirming an unknown result', async kind => {
    const artifact = scriptAdoptionFixture(kind);
    const inspection = { kind, savedState: 'diverged', current: {
      fps: 30, totalFrames: 60,
      scriptDocument: artifact.input.alignment.packet.script,
      scriptDocumentMatchesInput: true, telopsMatchInput: false, cutRegionsMatchInput: true, cutOrderMatchInput: true,
      targetTelops: [{ id: 1, before: 'ハイ', after: 'はい', current: { text: '現在の字幕', originalStart: 15, originalEnd: 45 } }],
      cutRegions: [], cutOrder: [],
    } };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.endsWith('/review') ? { runId: 'run', snapshotHash: 'hash', targets: [], script: inspection }
        : url.endsWith('/reconcile') ? {} : { operations: [{
          runId: 'run', createdAt: 1, phase: 'unknown', humanReview: 'pending',
          confirmed: { applied: false, saved: false },
          request: { projectId: 'project', changes: [], script: { judgmentId: 'judgment', artifact } },
        }], total: 1, nextOffset: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<AgentActivityDialog projectId="project" credentials={{ sessionId: 'browser', sessionKey: 'key' }} connection="connected" connectionError={null} onClose={() => {}} />);
    const reviewButton = await screen.findByRole('button', { name: '保存内容を確認して再開' });
    expect(isModalOpen()).toBe(true);
    expect(isAgentEditBlocked()).toBe(false);
    fireEvent.click(reviewButton);
    expect(isAgentEditBlocked()).toBe(true);
    await screen.findByTestId('script-saved-state-review');
    expect(isAgentEditBlocked()).toBe(true);
    expect(screen.getByText('保存内容：変更前とも変更案とも異なります')).toBeTruthy();
    expect(screen.getByText('保存されている台本')).toBeTruthy();
    expect(screen.queryByText('字幕0件の修正')).toBeNull();
    if (kind === 'caption') expect(screen.getByText('保存内容：現在の字幕')).toBeTruthy();
    else expect(screen.getByText('台本に沿った構成の編集')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'この保存内容から再開する' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some(url => url.endsWith('/reconcile'))).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some(url => url.endsWith('/reconcile'))).toBe(true));
    await screen.findByText('保存内容の確認を記録しました。新しいAI編集を再開できます。');
    expect(isAgentEditBlocked()).toBe(false);
    expect(isModalOpen()).toBe(true);
  });
});
