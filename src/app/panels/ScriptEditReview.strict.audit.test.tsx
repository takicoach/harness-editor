// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildLiteralAlignments } from '../../core/scriptAlignment';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import { createScriptEditArtifact, sealScriptEditInput } from '../../server/scriptEditArtifacts';
import { initialEditState, type EditState } from '../edit/editState';
import type { EditSession } from '../useEditSession';
import { ScriptEditReview } from './ScriptEditReview';

const script = createScriptDocument('はい\n未対応', { documentId: 'audit-script', revision: 'r1' });
const transcript = { durationMs: 3_000, words: [{ text: 'はい', start: 100, end: 900 }], segments: [] };

function draft(projectId = 'owned') {
  const packet = sealScriptInputPacket({
    schemaVersion: 1,
    packetHash: '0'.repeat(64),
    projectId,
    editRevision: 'edit-audit',
    source: { id: 'main.mp4', revision: 'source-audit', durationMs: 3_000 },
    script,
    transcript: {
      revision: 'transcript-audit',
      words: transcript.words.map((word, index) => ({
        index, text: word.text, startMs: word.start, endMs: word.end,
      })),
    },
  });
  const generator = {
    skillId: 'subtitle-orthography' as const,
    skillVersion: 'audit-1',
    provider: 'fixture',
    model: 'synthetic',
    configHash: '0'.repeat(64),
  };
  const input = sealScriptEditInput({
    schemaVersion: 1,
    inputHash: '0'.repeat(64),
    alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator)),
    editing: {
      fps: 30,
      totalFrames: 90,
      telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }],
      cutRegions: [],
      cutOrder: [],
    },
  });
  return createScriptEditArtifact(input, {
    schemaVersion: 1,
    kind: 'caption',
    proposalId: `script-edit:caption:${input.inputHash}`,
    inputHash: input.inputHash,
    generator,
    passages: [
      { passageId: 'passage-1', action: 'use', candidateIndex: 0, reason: '台本表記に合わせる' },
      { passageId: 'passage-2', action: 'skip', reason: '対応候補なし・要確認' },
    ],
    changes: [{
      telopId: 1,
      before: 'ハイ',
      after: 'はい',
      passageId: 'passage-1',
      scriptRange: { start: 0, end: 2 },
      wordRef: { transcriptRevision: 'transcript-audit', startIndex: 0, endIndex: 1 },
    }],
  });
}

function largeDraft(count: number) {
  const document = createScriptDocument([
    'はい',
    ...Array.from({ length: count - 1 }, (_, index) => `未対応${index + 2}`),
  ].join('\n'), { documentId: 'large-audit-script', revision: 'r1' });
  const packet = sealScriptInputPacket({
    schemaVersion: 1,
    packetHash: '0'.repeat(64),
    projectId: 'owned',
    editRevision: 'edit-large-audit',
    source: { id: 'main.mp4', revision: 'source-audit', durationMs: 3_000 },
    script: document,
    transcript: {
      revision: 'transcript-audit',
      words: transcript.words.map((word, index) => ({ index, text: word.text, startMs: word.start, endMs: word.end })),
    },
  });
  const generator = {
    skillId: 'subtitle-orthography' as const,
    skillVersion: 'audit-1',
    provider: 'fixture',
    model: 'synthetic',
    configHash: '0'.repeat(64),
  };
  const alignment = createScriptProposalArtifact(packet, buildLiteralAlignments(packet, generator));
  const input = sealScriptEditInput({
    schemaVersion: 1,
    inputHash: '0'.repeat(64),
    alignment,
    editing: {
      fps: 30,
      totalFrames: 90,
      telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }],
      cutRegions: [],
      cutOrder: [],
    },
  });
  return {
    document,
    artifact: createScriptEditArtifact(input, {
      schemaVersion: 1,
      kind: 'caption',
      proposalId: `script-edit:caption:${input.inputHash}`,
      inputHash: input.inputHash,
      generator,
      passages: alignment.proposals.map((proposal, index) => index === 0
        ? { passageId: proposal.passageId, action: 'use' as const, candidateIndex: 0, reason: '台本表記に合わせる' }
        : { passageId: proposal.passageId, action: 'skip' as const, reason: '対応候補なし・要確認' }),
      changes: [{
        telopId: 1,
        before: 'ハイ',
        after: 'はい',
        passageId: alignment.proposals[0]!.passageId,
        scriptRange: alignment.proposals[0]!.scriptRange,
        wordRef: { transcriptRevision: 'transcript-audit', startIndex: 0, endIndex: 1 },
      }],
    }),
  };
}

function session(stateOverride: Partial<EditState> = {}): EditSession {
  const state = {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    scriptDocument: script,
    originalTotalFrames: 90,
    telops: [{ id: 1, text: 'ハイ', originalStart: 0, originalEnd: 30 }],
    ...stateOverride,
  };
  return {
    state,
    dirty: false,
    saveStatus: 'idle',
    apply: vi.fn(),
    save: vi.fn(),
    sessionGuard: () => () => true,
  } as unknown as EditSession;
}

function choose(value: unknown, size?: number) {
  const body = JSON.stringify(value);
  const file = new File([body], 'audit.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => body });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(screen.getByLabelText('スキルの変更案を読み込む'), { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ScriptEditReview strict audit', () => {
  it('rejects a server-current draft when the still-open screen has a different editing snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(draft()))));
    const staleScreen = session({ telops: [{ id: 1, text: '別の表記', originalStart: 0, originalEnd: 30 }] });
    render(<ScriptEditReview projectId="owned" mode="caption" session={staleScreen} transcript={transcript}
      previewVersion="1-1" projectStale={false} onSeekSource={vi.fn()} />);
    choose(draft());
    expect((await screen.findByRole('alert')).textContent).toContain('画面の台本・発話と変更案が一致しません');
    expect(screen.queryByText('未適用')).toBeNull();
  });

  it('drops an old response after the requested project changes', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const active = session();
    const view = render(<ScriptEditReview projectId="owned" mode="caption" session={active} transcript={transcript}
      previewVersion="1-1" projectStale={false} onSeekSource={vi.fn()} />);
    choose(draft());
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.rerender(<ScriptEditReview projectId="other" mode="caption" session={active} transcript={transcript}
      previewVersion="1-1" projectStale={false} onSeekSource={vi.fn()} />);
    resolve(new Response(JSON.stringify(draft())));
    expect((await screen.findByRole('alert')).textContent).toContain('確認中に編集内容が変わりました');
    expect(screen.queryByText('未適用')).toBeNull();
  });

  it('rejects an oversized file before reading, posting, seeking, applying, or saving', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const active = session();
    const seek = vi.fn();
    render(<ScriptEditReview projectId="owned" mode="caption" session={active} transcript={transcript}
      previewVersion="1-1" projectStale={false} onSeekSource={seek} />);
    choose({}, 16 * 1024 * 1024 + 1);
    expect((await screen.findByRole('alert')).textContent).toContain('16MB以内');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(active.apply).not.toHaveBeenCalled();
    expect(active.save).not.toHaveBeenCalled();
  });

  it('validates a 2,000-passage draft while rendering the review in bounded pages', async () => {
    const large = largeDraft(2_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(large.artifact))));
    const active = session({ scriptDocument: large.document });
    render(<ScriptEditReview projectId="owned" mode="caption" session={active} transcript={transcript}
      previewVersion="1-1" projectStale={false} onSeekSource={vi.fn()} />);
    choose(large.artifact);
    const list = await screen.findByLabelText('台本ごとの提案理由');
    expect(list.children).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: '変更案の続きを表示' }));
    expect(list.children).toHaveLength(40);
    expect(active.apply).not.toHaveBeenCalled();
    expect(active.save).not.toHaveBeenCalled();
  });
});
