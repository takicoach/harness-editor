import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstructionInbox, validateInstructionInput } from './instructionInbox';

const timestamp = 1_800_000_000_000;
const input = { projectId: 'A', projectDir: '/owned/A', text: '字幕を直して',
  context: { frame: 30, timeSec: 1, selection: null }, requestId: 'request-1234567890', requestCreatedAt: timestamp };

describe('instruction receipt recovery', () => {
  it('lost acknowledgement replay cannot queue or execute the work twice', () => {
    const inbox = createInstructionInbox({ now: () => timestamp });
    const first = inbox.enqueue(input);
    expect(inbox.enqueue({ ...input })).toBe(first);
    expect(inbox.takeNext()?.id).toBe(first.id);
    inbox.updateStatus(first.id, 'done', '変更しました');
    expect(inbox.enqueue({ ...input }).status).toBe('done');
    expect(inbox.takeNext()).toBeNull();
    expect(inbox.list('A')).toHaveLength(1);
  });
  it('rejects reuse for a different project, text or playhead', () => {
    const inbox = createInstructionInbox({ now: () => timestamp });inbox.enqueue(input);
    for (const changed of [{ ...input, projectId: 'B' }, { ...input, text: '別の依頼' },
      { ...input, context: { ...input.context, frame: 31 } }]) {
      expect(() => inbox.enqueue(changed)).toThrow('同じ受付番号');
    }
    expect(inbox.list('A')).toHaveLength(1);
    expect(inbox.list('B')).toHaveLength(0);
  });
  it('rejects new stale/future submissions without creating a record', () => {
    const inbox = createInstructionInbox({ now: () => timestamp });
    for (const requestCreatedAt of [timestamp - 86_400_001, timestamp + 300_001]) {
      expect(() => inbox.enqueue({ ...input, requestCreatedAt })).toThrow('受付確認期限');
    }
    expect(inbox.list('A')).toHaveLength(0);
  });
  it('recovers a completed receipt after a real disk reload, even after the new-request deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'instruction-receipt-'));const file = join(root, 'inbox.json');
    const first = createInstructionInbox({ now: () => timestamp });
    const second = createInstructionInbox({ now: () => timestamp + 2 * 86_400_000 });
    try {
      first.attachPersistence(file, { resolveProjectDir: () => '/owned/A' });
      const record = first.enqueue(input);first.takeNext();first.updateStatus(record.id, 'done', '保存を確認');first.releasePersistence();
      second.attachPersistence(file, { resolveProjectDir: () => '/owned/A' });
      expect(second.enqueue(input)).toMatchObject({ id: record.id, status: 'done', reply: '保存を確認' });
      expect(second.takeNext()).toBeNull();
    } finally { first.releasePersistence();second.releasePersistence();rmSync(root, { recursive: true, force: true }); }
  });
  it('does not revive a request after its terminal record aged out', () => {
    const root = mkdtempSync(join(tmpdir(), 'instruction-expiry-'));const file = join(root, 'inbox.json');
    const first = createInstructionInbox({ now: () => timestamp });const later = createInstructionInbox({ now: () => timestamp + 8 * 86_400_000 });
    try {
      first.attachPersistence(file, { resolveProjectDir: () => '/owned/A' });const record = first.enqueue(input);
      first.takeNext();first.updateStatus(record.id, 'done');first.releasePersistence();
      later.attachPersistence(file, { resolveProjectDir: () => '/owned/A' });
      expect(later.list('A')).toHaveLength(0);expect(() => later.enqueue(input)).toThrow('受付確認期限');
    } finally { first.releasePersistence();later.releasePersistence();rmSync(root, { recursive: true, force: true }); }
  });
  it('requires the identity and timestamp pair, while preserving legacy input', () => {
    expect(validateInstructionInput(input)).toMatchObject({ requestId: input.requestId, requestCreatedAt: timestamp });
    expect(() => validateInstructionInput({ ...input, requestCreatedAt: undefined })).toThrow();
    expect(() => validateInstructionInput({ ...input, requestId: undefined })).toThrow();
    const { requestId: _id, requestCreatedAt: _at, ...legacy } = input;
    expect(validateInstructionInput(legacy)).not.toHaveProperty('requestId');
  });
});
