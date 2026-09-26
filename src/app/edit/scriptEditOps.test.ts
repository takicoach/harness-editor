import { describe, expect, it } from 'vitest';
import { buildLiteralAlignments, type AlignmentGenerator, type ScriptInputPacket } from '../../core/scriptAlignment';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import type { ScriptEditInput, ScriptEditProposal } from '../../core/scriptEditProposal';
import type { SegmentLayout } from '../../core/types';
import { initialEditState, type EditState } from './editState';
import { createHistory, current, pushState, undo } from './history';
import { applyScriptEditArtifact } from './scriptEditOps';

const INPUT_HASH = 'c'.repeat(64);

function generator(skillId: AlignmentGenerator['skillId']): AlignmentGenerator {
  return { skillId, skillVersion: '1', provider: 'fixture', model: 'fixture', configHash: 'b'.repeat(64) };
}

function packet(contiguous = false): ScriptInputPacket {
  return {
    schemaVersion: 1,
    packetHash: 'a'.repeat(64),
    projectId: 'project',
    editRevision: 'edit-1',
    source: { id: 'main.mp4', revision: 'source-1', durationMs: 4_000 },
    script: {
      schemaVersion: 1,
      documentId: 'script',
      revision: 'script-1',
      text: '正しいA\n正しいB',
      passages: [
        { id: 'a', range: { start: 0, end: 4 } },
        { id: 'b', range: { start: 5, end: 9 } },
      ],
    },
    transcript: {
      revision: 'transcript-1',
      words: contiguous
        ? [
          { index: 0, text: '正しいA', startMs: 0, endMs: 2_000 },
          { index: 1, text: '正しいB', startMs: 2_000, endMs: 4_000 },
        ]
        : [
          { index: 0, text: '正しいA', startMs: 400, endMs: 1_200 },
          { index: 1, text: '正しいB', startMs: 2_400, endMs: 3_200 },
        ],
    },
  };
}

function input(kind: 'caption' | 'structure', contiguous = false): ScriptEditInput {
  const skillId = kind === 'caption' ? 'subtitle-orthography' : 'script-structure';
  const p = packet(contiguous);
  return {
    schemaVersion: 1,
    inputHash: INPUT_HASH,
    alignment: {
      schemaVersion: 1,
      kind: 'script-alignment-proposals',
      state: 'unapplied',
      packet: p,
      proposals: buildLiteralAlignments(p, generator(skillId)),
    },
    editing: {
      fps: 30,
      totalFrames: 120,
      telops: [
        { id: 1, originalStart: 0, originalEnd: 50, text: '誤A' },
        { id: 2, originalStart: 60, originalEnd: 120, text: '誤B' },
      ],
      cutRegions: contiguous ? [] : [{ start: 50, end: 60 }],
      cutOrder: contiguous
        ? [{ originalStart: 60, originalEnd: 120 }, { originalStart: 0, originalEnd: 60 }]
        : [],
    },
  };
}

function proposal(kind: 'caption' | 'structure', skipB = false): ScriptEditProposal {
  const passages = [
    { passageId: 'a', action: 'use' as const, candidateIndex: 0, reason: '台本と一致' },
    skipB
      ? { passageId: 'b', action: 'skip' as const, reason: '今回は使わない' }
      : { passageId: 'b', action: 'use' as const, candidateIndex: 0, reason: '台本と一致' },
  ];
  if (kind === 'structure') {
    return {
      schemaVersion: 1,
      kind,
      proposalId: `script-edit:${kind}:${INPUT_HASH}`,
      inputHash: INPUT_HASH,
      generator: generator('script-structure'),
      passages,
    };
  }
  return {
    schemaVersion: 1,
    kind,
    proposalId: `script-edit:${kind}:${INPUT_HASH}`,
    inputHash: INPUT_HASH,
    generator: generator('subtitle-orthography'),
    passages,
    changes: [
      {
        telopId: 1,
        before: '誤A',
        after: '正しいA',
        passageId: 'a',
        scriptRange: { start: 0, end: 4 },
        wordRef: { transcriptRevision: 'transcript-1', startIndex: 0, endIndex: 1 },
      },
      ...skipB ? [] : [{
        telopId: 2,
        before: '誤B',
        after: '正しいB',
        passageId: 'b',
        scriptRange: { start: 5, end: 9 },
        wordRef: { transcriptRevision: 'transcript-1', startIndex: 1, endIndex: 2 },
      }],
    ],
  };
}

function artifact(kind: 'caption' | 'structure', options: { skipB?: boolean; contiguous?: boolean } = {}): ScriptEditArtifact {
  return {
    schemaVersion: 1,
    kind: 'script-edit-proposal',
    state: 'unapplied',
    input: input(kind, options.contiguous),
    proposal: proposal(kind, options.skipB),
  };
}

function editState(value: ScriptEditInput): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    scriptDocument: structuredClone(value.alignment.packet.script),
    originalTotalFrames: value.editing.totalFrames,
    telops: value.editing.telops.map(t => ({ ...t })),
    cutRegions: value.editing.cutRegions.map(c => ({ ...c })),
    cutOrder: value.editing.cutOrder.map(c => ({ ...c })),
  };
}

function layout(scale: number): SegmentLayout {
  return { position: { x: 0, y: 0 }, scale, rotation: 0, flipH: false, flipV: false };
}

describe('applyScriptEditArtifact caption', () => {
  it('applies every caption change atomically without changing timing or unrelated state', () => {
    const value = artifact('caption');
    const before = { ...editState(value.input), selection: { kind: 'telop' as const, id: 1 } };
    const snapshot = structuredClone(before);

    const after = applyScriptEditArtifact(before, value);

    expect(after.telops.map(t => t.text)).toEqual(['正しいA', '正しいB']);
    expect(after.telops.map(({ id, originalStart, originalEnd }) => ({ id, originalStart, originalEnd })))
      .toEqual(before.telops.map(({ id, originalStart, originalEnd }) => ({ id, originalStart, originalEnd })));
    expect(after.cutRegions).toBe(before.cutRegions);
    expect(after.cutOrder).toBe(before.cutOrder);
    expect(after.selection).toBe(before.selection);
    expect(before).toEqual(snapshot);
  });

  it.each(['script', 'telops', 'cuts', 'order', 'total'] as const)('rejects a stale %s snapshot before applying anything', field => {
    const value = artifact('caption');
    const before = editState(value.input);
    const stale: EditState = field === 'script'
      ? { ...before, scriptDocument: { ...before.scriptDocument!, revision: 'new-script' } }
      : field === 'telops'
        ? { ...before, telops: before.telops.map(t => t.id === 1 ? { ...t, text: '人が変更' } : t) }
        : field === 'cuts'
          ? { ...before, cutRegions: [] }
          : field === 'order'
            ? { ...before, cutOrder: [
              { originalStart: 60, originalEnd: 120 },
              { originalStart: 0, originalEnd: 50 },
            ] }
            : { ...before, originalTotalFrames: 121 };
    const snapshot = structuredClone(stale);

    expect(() => applyScriptEditArtifact(stale, value)).toThrow(/STALE_SCRIPT_EDIT/);
    expect(stale).toEqual(snapshot);
  });

  it('runs the shared core validation before applying', () => {
    const value = artifact('caption');
    const invalid = { ...value, proposal: { ...value.proposal, unexpected: true } } as unknown as ScriptEditArtifact;
    expect(() => applyScriptEditArtifact(editState(value.input), invalid)).toThrow();
  });

  it('applies human caption wording as one pure state change while retaining source timing and the model artifact', () => {
    const value = artifact('caption');
    const before = editState(value.input);
    const artifactSnapshot = structuredClone(value);
    const after = applyScriptEditArtifact(before, value, {
      kind: 'caption',
      changes: [{ telopId: 2, after: '人のB' }, { telopId: 1, after: '人のA' }],
    });

    expect(after.telops.map(t => [t.text, t.originalStart, t.originalEnd])).toEqual([
      ['人のA', 0, 50], ['人のB', 60, 120],
    ]);
    expect(value).toEqual(artifactSnapshot);
    expect(current(undo(pushState(createHistory(before), after)))).toEqual(before);
  });

  it('checks the current input before rejecting a malformed modification', () => {
    const value = artifact('caption');
    const stale = { ...editState(value.input), originalTotalFrames: 121 };
    expect(() => applyScriptEditArtifact(stale, value, {
      kind: 'structure', cutOrder: [{ originalStart: 0, originalEnd: 120 }],
    })).toThrow(/STALE_SCRIPT_EDIT/);
  });
});

describe('applyScriptEditArtifact structure', () => {
  it('replaces cuts and order together, carrying clip settings, transitions, and selection by source containment', () => {
    const value = artifact('structure');
    const before: EditState = {
      ...editState(value.input),
      segmentSpeeds: { 1: 1.25, 2: 1.5 },
      segmentLayouts: { 1: layout(1.2), 2: layout(1.4) },
      sceneTransitions: [
        { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 10 },
        { id: 2, at: 50, kind: 'crossfade', durationFrames: 12 },
        { id: 3, at: 'tail', kind: 'fadeWhite', durationFrames: 10 },
      ],
      selection: { kind: 'cutSegment', id: 2 },
    };

    const after = applyScriptEditArtifact(before, value);

    expect(after.cutRegions).toEqual([
      { start: 0, end: 12 },
      { start: 36, end: 72 },
      { start: 96, end: 120 },
    ]);
    expect(after.cutOrder).toEqual([
      { originalStart: 12, originalEnd: 36 },
      { originalStart: 72, originalEnd: 96 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.25, 2: 1.5 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.2), 2: layout(1.4) });
    expect(after.sceneTransitions).toEqual([
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 10 },
      { id: 2, at: 36, kind: 'crossfade', durationFrames: 12 },
      { id: 3, at: 'tail', kind: 'fadeWhite', durationFrames: 10 },
    ]);
    expect(after.selection).toEqual({ kind: 'cutSegment', id: 2 });
    expect(before.cutRegions).toEqual([{ start: 50, end: 60 }]);
  });

  it('moves a selected join with its source clips and clears disappeared selections and transitions', () => {
    const value = artifact('structure');
    const withJoin: EditState = {
      ...editState(value.input),
      sceneTransitions: [{ id: 1, at: 50, kind: 'fadeBlack', durationFrames: 10 }],
      selection: { kind: 'join', at: 50 },
    };
    expect(applyScriptEditArtifact(withJoin, value).selection).toEqual({ kind: 'join', at: 36 });

    const reduced = artifact('structure', { skipB: true });
    const withRemovedClip: EditState = {
      ...editState(reduced.input),
      sceneTransitions: [
        { id: 1, at: 50, kind: 'fadeBlack', durationFrames: 10 },
        { id: 2, at: 'tail', kind: 'fadeWhite', durationFrames: 10 },
      ],
      selection: { kind: 'cutSegment', id: 2 },
    };
    const after = applyScriptEditArtifact(withRemovedClip, reduced);
    expect(after.selection).toBeNull();
    expect(after.sceneTransitions).toEqual([{ id: 2, at: 'tail', kind: 'fadeWhite', durationFrames: 10 }]);
  });

  it('copies one source clip setting to each retained child when the proposal splits it', () => {
    const base = artifact('structure');
    const value: ScriptEditArtifact = {
      ...base,
      input: { ...base.input, editing: { ...base.input.editing, cutRegions: [{ start: 100, end: 120 }] } },
    };
    const before: EditState = {
      ...editState(value.input),
      segmentSpeeds: { 1: 1.5 },
      segmentLayouts: { 1: layout(1.2) },
      selection: { kind: 'cutSegment', id: 1 },
    };

    const after = applyScriptEditArtifact(before, value);

    expect(after.segmentSpeeds).toEqual({ 1: 1.5, 2: 1.5 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.2), 2: layout(1.2) });
    expect(after.selection).toBeNull();
  });

  it.each([
    ['speed', { 1: 1.5, 2: 2 }, {}],
    ['layout', {}, { 1: layout(1.2), 2: layout(1.4) }],
  ] as const)('rejects %s loss when differently configured source clips fuse', (_name, speeds, layouts) => {
    const value = artifact('structure', { contiguous: true });
    // The proposal's first range (0..60) crosses this existing 30-frame
    // boundary. Adjacent proposal ranges now remain separate timeline clips.
    value.input.editing.cutOrder = [
      { originalStart: 30, originalEnd: 120 },
      { originalStart: 0, originalEnd: 30 },
    ];
    const before: EditState = {
      ...editState(value.input),
      segmentSpeeds: { ...speeds } as Record<number, number>,
      segmentLayouts: { ...layouts } as Record<number, SegmentLayout>,
    };
    const snapshot = structuredClone(before);

    expect(() => applyScriptEditArtifact(before, value)).toThrow(/SCRIPT_EDIT_SEGMENT_.*_CONFLICT/);
    expect(before).toEqual(snapshot);
  });

  it('preserves explicit adjacent proposal boundaries and their settings', () => {
    const value = artifact('structure', { contiguous: true });
    const same = layout(1.3);
    const before: EditState = {
      ...editState(value.input),
      segmentSpeeds: { 1: 1.5, 2: 1.5 },
      segmentLayouts: { 1: same, 2: { ...same, position: { ...same.position } } },
    };

    const after = applyScriptEditArtifact(before, value);

    expect(after.cutOrder).toEqual([
      { originalStart: 0, originalEnd: 60 },
      { originalStart: 60, originalEnd: 120 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.5, 2: 1.5 });
    expect(after.segmentLayouts).toEqual({ 1: same, 2: same });
  });

  it('keeps different speeds and layouts on adjacent clips when restoring script order', () => {
    const value = artifact('structure', { contiguous: true });
    const before = { ...editState(value.input), segmentSpeeds: { 1: 1.5, 2: 2 }, segmentLayouts: { 1: layout(1.2), 2: layout(1.4) } };
    const after = applyScriptEditArtifact(before, value);
    // IDs follow playback order; settings follow the original source range.
    expect(after.segmentSpeeds).toEqual({ 1: 2, 2: 1.5 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.4), 2: layout(1.2) });
  });

  it('rejects an orphaned numeric transition instead of silently attaching it to another join', () => {
    const value = artifact('structure');
    const before: EditState = {
      ...editState(value.input),
      sceneTransitions: [{ id: 1, at: 999, kind: 'fadeBlack', durationFrames: 10 }],
    };
    expect(() => applyScriptEditArtifact(before, value)).toThrow(/SCRIPT_EDIT_TRANSITION_CONFLICT/);
  });

  it('applies human order and trims, carries source settings, and retains caption originals', () => {
    const value = artifact('structure');
    const before: EditState = {
      ...editState(value.input),
      segmentSpeeds: { 1: 1.25, 2: 1.5 },
      segmentLayouts: { 1: layout(1.2), 2: layout(1.4) },
      selection: { kind: 'cutSegment', id: 2 },
    };
    const telopSnapshot = structuredClone(before.telops);
    const artifactSnapshot = structuredClone(value);

    const after = applyScriptEditArtifact(before, value, {
      kind: 'structure',
      cutOrder: [
        { originalStart: 70, originalEnd: 100 },
        { originalStart: 10, originalEnd: 40 },
      ],
    });

    expect(after.cutRegions).toEqual([
      { start: 0, end: 10 }, { start: 40, end: 70 }, { start: 100, end: 120 },
    ]);
    expect(after.cutOrder).toEqual([
      { originalStart: 70, originalEnd: 100 },
      { originalStart: 10, originalEnd: 40 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.5, 2: 1.25 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.4), 2: layout(1.2) });
    expect(after.selection).toEqual({ kind: 'cutSegment', id: 1 });
    expect(after.telops).toEqual(telopSnapshot);
    expect(value).toEqual(artifactSnapshot);
  });
});
