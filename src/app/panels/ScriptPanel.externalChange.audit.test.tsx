// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { buildLiteralAlignments } from '../../core/scriptAlignment';
import { createScriptProposalArtifact, sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import { initialEditState } from '../edit/editState';
import type { EditSession } from '../useEditSession';
import { ScriptPanel } from './ScriptPanel';

const script = createScriptDocument('発話', { documentId: 'script', revision: 'script-r1' });
const transcript = { durationMs: 1000, words: [{ text: '発話', start: 100, end: 300 }], segments: [] };

function artifact() {
  const packet = sealScriptInputPacket({
    schemaVersion: 1,
    packetHash: '0'.repeat(64),
    projectId: 'owned',
    editRevision: 'edit-r1',
    source: { id: 'main.mp4', revision: 'source-r1', durationMs: 1000 },
    script,
    transcript: { revision: 'transcript-r1', words: [{ index: 0, text: '発話', startMs: 100, endMs: 300 }] },
  });
  return createScriptProposalArtifact(packet, buildLiteralAlignments(packet, {
    skillId: 'subtitle-orthography',
    skillVersion: '1',
    provider: 'deterministic',
    model: 'literal-v1',
    configHash: 'a'.repeat(64),
  }));
}

function Harness({ projectStale = false }: { projectStale?: boolean }) {
  const [state, setState] = useState(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    scriptDocument: script,
  }));
  const session = {
    state,
    apply: setState,
    dirty: false,
    saveStatus: 'idle',
    save: vi.fn(async () => true),
    sessionGuard: () => () => true,
  } as unknown as EditSession;
  // projectStale models useEditorProject.externallyChanged. It must invalidate correspondence
  // even while the currently loaded project/session object and preview-version string stay unchanged.
  const props = { projectId: 'owned', session, transcript, previewVersion: 'preview-v1', projectStale, onSeekSource: vi.fn() };
  return <ScriptPanel {...(props as Parameters<typeof ScriptPanel>[0])} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScriptPanel external project change audit', () => {
  it('disables an already displayed source candidate after the project watcher reports a disk change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(artifact()), { status: 200 })));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    const candidate = await screen.findByRole('button', { name: '0:00.1–0:00.3' });
    expect((candidate as HTMLButtonElement).disabled).toBe(false);

    view.rerender(<Harness projectStale />);
    expect((screen.getByRole('button', { name: '0:00.1–0:00.3' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not publish a response that arrives after the watcher reports a disk change', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '発話と照合' }));
    view.rerender(<Harness projectStale />);
    finish(new Response(JSON.stringify(artifact()), { status: 200 }));

    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByLabelText('台本の照合結果')).toBeNull();
  });
});
