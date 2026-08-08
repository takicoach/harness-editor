import { describe, expect, it } from 'vitest';
import { createInstructionInbox } from '../instructionInbox';
import { getNextInstruction, reportInstructionStatus } from './tools';
import type { InstructionContext } from '../../shared/types';

const CTX: InstructionContext = { frame: 0, timeSec: 0, selection: null };
function enq(inbox: ReturnType<typeof createInstructionInbox>, text: string) {
  return inbox.enqueue({ projectId: 'p', projectDir: '/abs/p', text, context: CTX });
}

describe('getNextInstruction', () => {
  it('pending を Claude 向けペイロードで返す', async () => {
    const inbox = createInstructionInbox();
    enq(inbox, '赤にして');
    const out = await getNextInstruction(inbox, 1_000);
    expect(out.empty).toBe(false);
    if (out.empty === false) {
      expect(out.text).toBe('赤にして');
      expect(out.projectDir).toBe('/abs/p');
      expect(out.id).toBeTruthy();
    }
  });

  it('待っても無ければ empty を返す', async () => {
    const inbox = createInstructionInbox();
    const out = await getNextInstruction(inbox, 0);
    expect(out.empty).toBe(true);
  });
});

describe('getNextInstruction: projectId フィルタ（動画専属モード）', () => {
  it('projectId 指定でそのプロジェクトの pending だけ返す', async () => {
    const inbox = createInstructionInbox();
    inbox.enqueue({ projectId: 'A', projectDir: '/abs/A', text: 'Aへ', context: CTX });
    inbox.enqueue({ projectId: 'B', projectDir: '/abs/B', text: 'Bへ', context: CTX });
    const out = await getNextInstruction(inbox, 0, 'B');
    expect(out.empty).toBe(false);
    if (out.empty === false) {
      expect(out.projectId).toBe('B');
      expect(out.text).toBe('Bへ');
    }
  });

  it('projectId 未指定は従来通り全体から取得する（後方互換）', async () => {
    const inbox = createInstructionInbox();
    enq(inbox, '通常');
    const out = await getNextInstruction(inbox, 0);
    expect(out.empty).toBe(false);
    if (out.empty === false) expect(out.projectId).toBe('p');
  });

  it('該当プロジェクトに pending が無ければ empty を返す（他プロジェクトの pending は取らない）', async () => {
    const inbox = createInstructionInbox();
    inbox.enqueue({ projectId: 'A', projectDir: '/abs/A', text: 'Aへ', context: CTX });
    const out = await getNextInstruction(inbox, 0, 'B');
    expect(out.empty).toBe(true);
  });
});

describe('reportInstructionStatus', () => {
  it('done に更新し ok を返す', async () => {
    const inbox = createInstructionInbox();
    const rec = enq(inbox, 'x');
    inbox.takeNext();
    const out = reportInstructionStatus(inbox, { id: rec.id, status: 'done', reply: '完了' });
    expect(out.ok).toBe(true);
    const [first] = inbox.list('p');
    expect(first?.status).toBe('done');
  });

  it('未知 id は ok=false', () => {
    const inbox = createInstructionInbox();
    const out = reportInstructionStatus(inbox, { id: 'none', status: 'done', reply: '' });
    expect(out.ok).toBe(false);
  });
});
