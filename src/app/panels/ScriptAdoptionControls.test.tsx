// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../../core/__fixtures__/scriptAdoption';
import { scriptApplicationRequest } from '../edit/scriptAdoption';
import { appendDecisionEvent } from '../../learning/preferenceDecisions';
import type { PreferenceCommand, PreferenceWorkspace } from '../../learning/preferenceWorkspaceStore';
import type { EditorChangeSet } from '../../shared/editorCommands';
import type { ScriptAdoptionBridge } from '../useScriptAdoption';
import { ScriptAdoptionControls } from './ScriptAdoptionControls';

const artifact = scriptAdoptionFixture();
let workspace: PreferenceWorkspace;
let commands: PreferenceCommand[], requests: EditorChangeSet[];
let receipt: unknown, loseRecording: boolean, loseEnqueue: boolean, current: boolean;
const bridge = { sessionId: 'browser', read: () => ({ projectId: 'project', revision: 'r1', dirty: false, saving: false, humanBusy: false }) } as unknown as ScriptAdoptionBridge;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  sessionStorage.clear(); commands = []; requests = []; receipt = null; loseRecording = false; loseEnqueue = false; current = true;
  workspace = { schemaVersion: 1, decisions: { schemaVersion: 1, events: [] }, rules: [], evaluations: [], datasets: [], profiles: [], projectProfiles: {}, operations: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/preferences') return response({ ...workspace, recordingProvenance: 'synthetic' });
    if (url.startsWith('/api/script-edit-review?')) return response(artifact);
    if (url === '/api/preferences/command') {
      const command = JSON.parse(String(init?.body)) as PreferenceCommand; commands.push(command);
      if (command.kind === 'decision' && !workspace.decisions.events.some(e => e.id === command.event.id)) workspace = { ...workspace, decisions: appendDecisionEvent(workspace.decisions, command.event) };
      if (loseRecording) { loseRecording = false; throw new TypeError('response lost'); }
      return response({ ...workspace, recordingProvenance: 'synthetic' });
    }
    if (url.startsWith('/api/editor/operation?')) return receipt ? response(receipt) : response({}, 404);
    if (url === '/api/editor/operations') {
      const { request } = JSON.parse(String(init?.body)); requests.push(request);
      receipt = { runId: 'run', request, phase: 'running', confirmed: { applied: false, saved: false }, result: null };
      if (loseEnqueue) { loseEnqueue = false; throw new TypeError('enqueue response lost'); }
      return response(receipt);
    }
    throw new Error(`unexpected URL ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function open() { return render(<ScriptAdoptionControls artifact={artifact} bridge={bridge} disabled={false} isCurrent={() => current} onOpenActivity={() => {}} />); }
async function ready() { await waitFor(() => expect((screen.getByRole('button', { name: '採用して反映' }) as HTMLButtonElement).disabled).toBe(false)); }

describe('script adoption consent and recovery UI', () => {
  it('keeps the AI draft while recording the human correction and recovering its exact request', async () => {
    loseEnqueue = true;
    open(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '提案を直して採用する' }));
    const apply = screen.getByRole('button', { name: '直して採用して反映' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^採用して反映$/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('修正する字幕 1'), { target: { value: 'はい、そうです' } });
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);
    await screen.findByText('編集に反映しています');
    const modification = { kind: 'caption', changes: [{ telopId: 1, after: 'はい、そうです' }] };
    expect(commands).toHaveLength(1); expect(requests).toHaveLength(1);
    expect(commands[0]).toMatchObject({ event: { decision: 'accepted_modified', artifact, modification, learningConsent: false } });
    expect(requests[0]?.script).toMatchObject({ artifact, modification });
    expect(screen.getByText('人が修正した採用内容：はい、そうです')).toBeTruthy();
  });
  it('resets a correction to the original draft without submitting or enabling unchanged acceptance', async () => {
    open(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '提案を直して採用する' }));
    fireEvent.change(screen.getByLabelText('修正する字幕 1'), { target: { value: '修正しました' } });
    fireEvent.click(screen.getByRole('button', { name: '元の提案に戻す' }));
    expect((screen.getByRole('button', { name: '直して採用して反映' }) as HTMLButtonElement).disabled).toBe(true);
    expect(commands).toHaveLength(0); expect(requests).toHaveLength(0);
  });
  it('waits for editor synchronization only for applying, while allowing a deferred decision', async () => {
    render(<ScriptAdoptionControls artifact={artifact} bridge={bridge} disabled={false} connectionReady={false} isCurrent={() => true} onOpenActivity={() => {}} />);
    await waitFor(() => expect((screen.getByRole('button', { name: '保留' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('button', { name: '採用して反映' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保留' }));
    await screen.findByText('判断：保留を記録済み');
    expect(requests).toHaveLength(0);
  });
  it('records explicit acceptance without consent before requesting one editor operation', async () => {
    open(); await ready(); fireEvent.click(screen.getByRole('button', { name: '採用して反映' }));
    await screen.findByText('編集に反映しています');
    expect(commands).toHaveLength(1); expect(requests).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toMatchObject({ kind: 'decision', event: { decision: 'accepted', reasonCode: 'unspecified', note: '', learningConsent: false, provenance: { kind: 'synthetic' } } });
    if (command.kind !== 'decision') throw new Error('wrong command');
    expect(requests[0]?.operationId).toBe(`script:${command.event.id}`);
    expect(screen.queryByText('編集に反映し、保存しました')).toBeNull();
  });
  it.each(['却下', '保留'])('%s records a decision without sending an edit', async label => {
    open(); await ready(); fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByText(`判断：${label}を記録済み`);
    expect(requests).toHaveLength(0); expect(commands).toHaveLength(1);
  });
  it('reuses the pending judgment after a lost recording response, then reuses its operation ID', async () => {
    loseRecording = true; open(); await ready(); fireEvent.click(screen.getByRole('button', { name: '採用して反映' }));
    await screen.findByRole('button', { name: '記録の保存を再確認' }); expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '記録の保存を再確認' }));
    const retry = await screen.findByRole('button', { name: '同じ採用内容で反映を再確認' });
    fireEvent.click(retry); await screen.findByText('編集に反映しています');
    expect(commands).toHaveLength(2); expect(commands[0]?.operationId).toBe(commands[1]?.operationId);
    expect(workspace.decisions.events).toHaveLength(1); expect(requests).toHaveLength(1);
  });
  it('finds the existing operation when the enqueue response is lost', async () => {
    loseEnqueue = true; open(); await ready(); fireEvent.click(screen.getByRole('button', { name: '採用して反映' }));
    await screen.findByText('編集に反映しています'); expect(requests).toHaveLength(1);
  });
  it('reconnects a queued intent to the current browser without creating another judgment', async () => {
    const judgment = scriptJudgmentFixture();
    workspace.decisions = appendDecisionEvent(workspace.decisions, judgment);
    receipt = { runId: 'queued-run', request: scriptApplicationRequest(judgment, 'old-browser'), phase: 'queued',
      confirmed: { applied: false, saved: false }, result: null };
    open(); await screen.findByText('編集への反映を待っています');
    fireEvent.click(screen.getByRole('button', { name: '同じ採用内容で反映を再確認' }));
    await screen.findByText('編集に反映しています');
    expect(commands).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operationId: 'script:judgment', baseRevision: 'r1' });
  });
  it('refuses a stale review before recording any human decision', async () => {
    open(); await ready(); current = false; fireEvent.click(screen.getByRole('button', { name: '採用して反映' }));
    await screen.findByRole('alert'); expect(commands).toHaveLength(0); expect(requests).toHaveLength(0);
  });
  it('allows adoption after withdrawing learning consent from a deferred judgment without restoring consent', async () => {
    open(); await ready();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '保留' }));
    await screen.findByText('判断：保留を記録済み');
    fireEvent.click(screen.getByRole('button', { name: '学習への同意を撤回' }));
    await screen.findByText('学習への同意を撤回済みです。編集結果は変わりません。');
    await ready();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '採用して反映' }));
    await screen.findByText('編集に反映しています');
    expect(commands[2]).toMatchObject({ event: { decision: 'accepted', learningConsent: false } });
    expect(requests).toHaveLength(1);
  });
});
