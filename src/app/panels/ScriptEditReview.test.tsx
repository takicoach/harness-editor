// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { buildLiteralAlignments } from '../../core/scriptAlignment';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import { createScriptEditArtifact, sealScriptEditInput } from '../../server/scriptEditArtifacts';
import { initialEditState } from '../edit/editState';
import type { EditSession } from '../useEditSession';
import { ScriptEditReview } from './ScriptEditReview';

const script = createScriptDocument('はい\n未対応', { documentId: 'script', revision: 'r1' });
const transcript = { durationMs: 3000, words: [{ text: 'はい', start: 100, end: 900 }], segments: [] };
function artifact(kind: 'caption' | 'structure' = 'caption') {
  const packet = sealScriptInputPacket({ schemaVersion: 1, packetHash: '0'.repeat(64), projectId: 'owned', editRevision: 'edit1',
    source: { id: 'video.mp4', revision: 'video1', durationMs: 3000 }, script,
    transcript: { revision: 't1', words: transcript.words.map((w, index) => ({ index, text: w.text, startMs: w.start, endMs: w.end })) } });
  const generator = { skillId: kind === 'caption' ? 'subtitle-orthography' as const : 'script-structure' as const,
    skillVersion: '1', provider: 'fixture', model: 'synthetic', configHash: '0'.repeat(64) };
  const input = sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64),
    alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator)),
    editing: { fps: 30, totalFrames: 90, telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }], cutRegions: [], cutOrder: [] } });
  return createScriptEditArtifact(input, { schemaVersion: 1, kind, proposalId: `script-edit:${kind}:${input.inputHash}`,
    inputHash: input.inputHash, generator,
    passages: [{ passageId: 'passage-1', action: 'use', candidateIndex: 0, reason: '台本の表記に合わせる' },
      { passageId: 'passage-2', action: 'skip', reason: '対応候補なし・要確認' }],
    ...(kind === 'caption' ? { changes: [{ telopId: 1, before: 'ハイ', after: 'はい', passageId: 'passage-1',
      scriptRange: { start: 0, end: 2 }, wordRef: { transcriptRevision: 't1', startIndex: 0, endIndex: 1 } }] } : {}) });
}
const apply = vi.fn(), save = vi.fn(), seek = vi.fn();
const session = { state: { ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }), scriptDocument: script,
    originalTotalFrames: 90, telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }] },
  dirty: false, saveStatus: 'idle', apply, save, sessionGuard: () => () => true } as unknown as EditSession;
const props = { projectId: 'owned', mode: 'caption' as const, session, transcript, previewVersion: '1-1', projectStale: false, onSeekSource: seek };
function upload(body = artifact()) {
  const file = Object.assign(new File([JSON.stringify(body)], 'proposal.json'), { text: async () => JSON.stringify(body) });
  fireEvent.change(screen.getByLabelText('スキルの変更案を読み込む'), { target: { files: [file] } });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('ScriptEditReview', () => {
  it('shows caption before/after and every passage reason, seeks the subtitle midpoint without applying or saving', async () => {
    const fetch = vi.fn(async (_url: unknown) => new Response(JSON.stringify(artifact()))); vi.stubGlobal('fetch', fetch);
    render(<ScriptEditReview {...props} />); upload();
    await screen.findByRole('heading', { name: '字幕の表記案' });
    expect(screen.getByText('ハイ')).toBeTruthy();
    expect(screen.getByText('提案理由：対応候補なし・要確認')).toBeTruthy();
    expect(screen.getByText('未適用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'この字幕の区間を確認' }));
    expect(seek).toHaveBeenCalledExactlyOnceWith(500);
    expect(apply).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/script-edit-review?');
  });
  it('shows proposed script order and omitted source ranges for structure drafts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(artifact('structure')))));
    render(<ScriptEditReview {...props} mode="structure" />); upload(artifact('structure'));
    await screen.findByRole('heading', { name: '台本に沿った構成案' });
    expect(screen.getByText('提案：1区間を台本順に使用')).toBeTruthy();
    expect(screen.getByLabelText('提案で使わない原素材').textContent).toContain('0:00.9–0:03.0');
    fireEvent.click(screen.getByRole('button', { name: '0:00.1–0:00.9 の発話を確認' }));
    expect(seek).toHaveBeenCalledExactlyOnceWith(500); expect(apply).not.toHaveBeenCalled();
  });
  it('disables old preview after an external update and after switching purpose', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(artifact()))));
    const view = render(<ScriptEditReview {...props} />); upload();
    await screen.findByRole('heading', { name: '字幕の表記案' });
    view.rerender(<ScriptEditReview {...props} projectStale />);
    expect((screen.getByRole('button', { name: 'この字幕の区間を確認' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ScriptEditReview {...props} mode="structure" />);
    expect((screen.getByRole('button', { name: 'この字幕の区間を確認' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('discards in-flight results if the video changes, and allows cancellation', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn((_url: unknown, _init?: RequestInit) => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const view = render(<ScriptEditReview {...props} />); upload();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.rerender(<ScriptEditReview {...props} previewVersion="2-2" />);
    resolve(new Response(JSON.stringify(artifact())));
    expect((await screen.findByRole('alert')).textContent).toContain('確認中に編集内容が変わりました');
    expect(screen.queryByText('未適用')).toBeNull();
    upload(); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '変更案の確認を中止' }));
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
  it('does not hide validation failures or accept a false applied receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...artifact(), state: 'applied' }))));
    render(<ScriptEditReview {...props} />); upload();
    await screen.findByRole('alert');
    expect(screen.queryByText('未適用')).toBeNull(); expect(apply).not.toHaveBeenCalled();
  });
});
