import { describe, expect, it } from 'vitest';
import { initialEditState, samePersistedContent } from './editState';
import { setShootingScriptText } from './scriptOps';

describe('shooting script edits', () => {
  it('preserves media, captions, selection and previous history snapshots', () => {
    const state = { ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
      cutRegions: [{ start: 30, end: 40 }], telops: [{ id: 1, text: '発話', originalStart: 10, originalEnd: 20 }] };
    const before = JSON.stringify(state);
    const next = setShootingScriptText(state, '  台本😀\r\n\r\n二行目');
    expect(next.scriptDocument?.text).toBe('  台本😀\r\n\r\n二行目');
    expect(next.scriptDocument?.passages).toHaveLength(2);
    expect(next.telops).toBe(state.telops);
    expect(next.cutRegions).toBe(state.cutRegions);
    expect(JSON.stringify(state)).toBe(before);
    expect(samePersistedContent(state, next)).toBe(false);
    expect(setShootingScriptText(next, next.scriptDocument!.text)).toBe(next);
    const removed = setShootingScriptText(next, '');
    expect(removed.scriptDocument).toBeNull();
    expect(samePersistedContent(state, removed)).toBe(true);
  });

  it('retains the document identity but invalidates the revision when its text changes', () => {
    const initial = initialEditState({ mainSpeed: 1, segmentSpeeds: {} });
    const first = setShootingScriptText(initial, '台本');
    const second = setShootingScriptText(first, '台本の修正');
    expect(second.scriptDocument?.documentId).toBe(first.scriptDocument?.documentId);
    expect(second.scriptDocument?.revision).not.toBe(first.scriptDocument?.revision);
    expect(first.scriptDocument?.text).toBe('台本');
  });
});
