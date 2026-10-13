import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstructionInbox, normalizeInstructionId, PASTE_SUPERSEDED_REPLY, PASTE_UNKNOWN_REPLY, PASTE_UNSENT_REPLY } from './instructionInbox';

const input = (projectId = 'slides-a', text = 'スライド: 構成案を作って') => ({ projectId, projectDir: `/root/${projectId}`, text, context: { frame: 0, timeSec: 0, selection: null } });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('貼り付けの依頼の記録', () => {
  it('依頼文の ESC・CR などの制御文字は除く（貼り付けを途中で閉じて自動送信させない）', async () => {
    const { validateInstructionInput } = await import('./instructionInbox');
    const base = { projectId: 'p', context: { frame: 0, timeSec: 0, selection: null } };
    expect(validateInstructionInput({ ...base, text: 'a\x1b[201~\rrm -rf\r\nb\x00' }).text).toBe('a[201~rm -rf\nb');
    expect(() => validateInstructionInput({ ...base, text: '\x1b\r' })).toThrow();
  });
  it('送信待ちの依頼の案件を返す', () => {
    const inbox = createInstructionInbox();
    inbox.enqueuePasted(input('slides-a'));
    expect(inbox.pendingPastedProjectIds()).toEqual(['slides-a']);
    inbox.markPastedSubmitted();
    expect(inbox.pendingPastedProjectIds()).toEqual([]);
  });
  it('送信待ちで記録し、get_next_instruction（takeNext）では配らない', () => {
    const inbox = createInstructionInbox();
    const { record, created } = inbox.enqueuePasted(input());
    expect(created).toBe(true);
    expect(record.status).toBe('pending');
    expect(inbox.takeNext()).toBeNull();
    expect(inbox.takeNext({ projectId: 'slides-a' })).toBeNull();
  });
  it('同じ requestId は作り直さない（貼り直さないための created=false）', () => {
    const inbox = createInstructionInbox(), withId = { ...input(), requestId: 'request-0000000000000001', requestCreatedAt: Date.now() };
    expect(inbox.enqueuePasted(withId).created).toBe(true);
    expect(inbox.enqueuePasted(withId)).toMatchObject({ created: false });
  });
  it('Enter で作業中、AI の報告で完了。送信待ちのまま報告が来ても受け付ける', () => {
    const inbox = createInstructionInbox();
    const first = inbox.enqueuePasted(input()).record;
    expect(inbox.markPastedSubmitted().map(record => record.id)).toEqual([first.id]);
    expect(inbox.list('slides-a')[0]!.status).toBe('processing');
    expect(inbox.updateStatus(first.id, 'done', '構成案を渡しました')?.status).toBe('done');
    const second = inbox.enqueuePasted(input()).record;
    expect(inbox.updateStatus(second.id, 'failed', '台本がありません')?.status).toBe('failed');
  });
  it('AI が終了したら、送信待ちは「送られませんでした」、作業中は「結果不明」', () => {
    const inbox = createInstructionInbox();
    const sent = inbox.enqueuePasted(input()).record;
    inbox.markPastedSubmitted();
    const unsent = inbox.enqueuePasted(input()).record;
    inbox.failPasted();
    const records = inbox.list('slides-a');
    expect(records.find(record => record.id === sent.id)).toMatchObject({ status: 'failed', reply: PASTE_UNKNOWN_REPLY });
    expect(records.find(record => record.id === unsent.id)).toMatchObject({ status: 'failed', reply: PASTE_UNSENT_REPLY });
  });
  it('別案件で手の依頼が送られたら、送信待ちだけを送られなかった扱いにし、作業中は触らない', () => {
    const inbox = createInstructionInbox();
    const sent = inbox.enqueuePasted(input()).record;
    inbox.markPastedSubmitted();
    const unsent = inbox.enqueuePasted(input()).record;
    expect(inbox.supersedePasted().map(record => record.id)).toEqual([unsent.id]);
    const records = inbox.list('slides-a');
    expect(records.find(record => record.id === sent.id)?.status).toBe('processing');
    expect(records.find(record => record.id === unsent.id)).toMatchObject({ status: 'failed', reply: PASTE_SUPERSEDED_REPLY });
    expect(inbox.pendingPastedProjectIds()).toEqual([]);
  });
  it('エディタの再起動をまたいだ送信待ちは「送られませんでした」で復元する（get_next_instruction に配らない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-paste-')); dirs.push(dir);
    const file = join(dir, '.sme-inbox.json');
    const before = createInstructionInbox();
    expect(before.attachPersistence(file, { resolveProjectDir: id => `/root/${id}` }).persisted).toBe(true);
    const record = before.enqueuePasted(input()).record;
    before.releasePersistence();
    const after = createInstructionInbox();
    after.attachPersistence(file, { resolveProjectDir: id => `/root/${id}` });
    expect(after.list('slides-a').find(item => item.id === record.id)).toMatchObject({ status: 'failed', reply: PASTE_UNSENT_REPLY });
    expect(after.takeNext()).toBeNull();
    after.releasePersistence();
  });
  it('依頼番号は #12・12・inst-12 のどれでも同じ記録を指す', () => {
    expect(normalizeInstructionId('#12')).toBe('inst-12');
    expect(normalizeInstructionId(' 12 ')).toBe('inst-12');
    expect(normalizeInstructionId('inst-12')).toBe('inst-12');
  });
});
