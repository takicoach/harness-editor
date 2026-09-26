// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { buildLiteralAlignments } from '../../core/scriptAlignment';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import { initialEditState, samePersistedContent } from '../edit/editState';
import type { EditSession } from '../useEditSession';
import { ScriptPanel } from './ScriptPanel';

const script = createScriptDocument('はい\n未撮影', { documentId: 'script', revision: 'script-r1' });
const words = [{ text: 'はい', start: 100, end: 300 }, { text: 'はい', start: 2100, end: 2300 }];
const transcript = { durationMs: 3000, words, segments: [] };
function artifact(projectId = 'owned') {
  const packet = sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId, editRevision: 'e1',
    source: { id: 'video.mp4', revision: 'video-r1', durationMs: 3000 }, script,
    transcript: { revision: 't1', words: words.map((word, index) => ({ index, text: word.text, startMs: word.start, endMs: word.end })) } });
  return createScriptProposalArtifact(packet, buildLiteralAlignments(packet, { skillId: 'subtitle-orthography', skillVersion: '1',
    provider: 'deterministic', model: 'literal-v1', configHash: '0'.repeat(64) }));
}
const seek = vi.fn();
function Harness({ save = vi.fn(async () => false), previewVersion = 'preview-v1' }: { save?: () => Promise<boolean>; previewVersion?: string }) {
  const [initial] = useState(() => ({ ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }), scriptDocument: script }));
  const [state, setState] = useState(initial);
  const session = { state, apply: setState, dirty: !samePersistedContent(state, initial), saveStatus: 'idle', save,
    sessionGuard: () => () => true } as unknown as EditSession;
  return <ScriptPanel projectId="owned" session={session} transcript={transcript} previewVersion={previewVersion} onSeekSource={seek} />;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('ScriptPanel correspondence review', () => {
  it('invalidates displayed candidates when the video version changes without a script edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(artifact()), { status: 200 })));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    await screen.findByText('候補が複数');
    view.rerender(<Harness previewVersion="replacement-video" />);
    expect((screen.getByRole('button', { name: '候補 1 0:00.1–0:00.3' }) as HTMLButtonElement).disabled).toBe(true);
    expect(seek).not.toHaveBeenCalled();
  });

  it('retains both takes and the unmatched sentence, and seeks only on explicit candidate clicks', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(artifact()), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    await screen.findByText('候補が複数');
    expect(screen.getByText('一致が見つかりません')).toBeTruthy();
    expect(seek).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '候補 2 0:02.1–0:02.3' }));
    expect(seek).toHaveBeenCalledExactlyOnceWith(2200);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('expectedPreviewVersion=preview-v1');
    fireEvent.change(screen.getByRole('textbox', { name: '撮影で使った台本' }), { target: { value: '変更した台本' } });
    expect((screen.getByRole('button', { name: '候補 1 0:00.1–0:00.3' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rejects another project response and an in-flight response after a script edit', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    resolve(new Response(JSON.stringify(artifact('other-project')), { status: 200 }));
    await screen.findByRole('alert');
    expect(screen.queryByText('候補が複数')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新しい原稿' } });
    resolve(new Response(JSON.stringify(artifact()), { status: 200 }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('編集内容が変わりました'));
    expect(screen.queryByText('候補が複数')).toBeNull();
  });

  it('does not request alignment after a failed save and can cancel an in-flight request', async () => {
    const save = vi.fn(async () => false);
    const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    render(<Harness save={save} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '編集中' } });
    fireEvent.click(screen.getByRole('button', { name: '保存して発話と照合' }));
    await screen.findByRole('alert');
    expect(save).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    fireEvent.click(screen.getByRole('button', { name: '照合を中止' }));
    expect((fetch.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: '照合を中止' })).toBeNull();
  });
});
