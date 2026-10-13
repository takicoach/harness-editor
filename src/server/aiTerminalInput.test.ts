import { describe, expect, it, vi } from 'vitest';
import type { AiScreen } from '../shared/aiFocus';
import { AiFocusRegistry } from './aiFocus';
import { handleTerminalInput, submitsInput } from './aiTerminalInput';

const screen = (projectId: string): AiScreen => ({ projectId, projectName: projectId, mode: 'video', target: null, playheadSec: null, selection: [], materials: '' });
/** 送信待ちの貼り付けの依頼（案件ごとに 1 件・本文 12 文字）。 */
const pasted = (...projectIds: string[]) => projectIds.map((projectId, index) => ({ id: `inst-${index + 1}`, projectId, textLength: 12 }));

describe('端末の送信（Enter）の検出', () => {
  it('打った Enter は送信。貼り付けの中の改行と Alt+Enter は送信に数えない', () => {
    expect(submitsInput('\r')).toBe(true);
    expect(submitsInput('冒頭を詰めて\r')).toBe(true);
    expect(submitsInput('abc')).toBe(false);
    expect(submitsInput('\x1b[200~1 行目\r2 行目\x1b[201~')).toBe(false);
    expect(submitsInput('\x1b[200~貼った\x1b[201~\r')).toBe(true);
    expect(submitsInput('\x1b\r')).toBe(false);
  });
  it('送信の時だけ、その時の主画面の状況を依頼時点にする', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted()) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    handleTerminalInput('冒頭を', { focus, inbox });
    expect(focus.request()).toBeNull();
    handleTerminalInput('詰めて\r', { focus, inbox });
    expect(focus.request()).toMatchObject({ projectId: 'a', mode: 'video' });
    focus.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('b') });
    handleTerminalInput('x', { focus, inbox });
    expect(focus.request()?.projectId).toBe('a');
    expect(inbox.markPastedSubmitted).not.toHaveBeenCalled();
  });
  it('依頼の後に別案件へ移って押した Enter（許可の確認など）は、依頼時点を広げず貼り付けも作業中にしない', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted('a')) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b') });
    handleTerminalInput('\r', { focus, inbox });
    expect(focus.request()).toBeNull();
    expect(inbox.markPastedSubmitted).not.toHaveBeenCalled();
    focus.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('a') });
    handleTerminalInput('\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('a');
    expect(inbox.markPastedSubmitted).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['Ctrl+U', '\x15'],
    ['Ctrl+C', '\x03'],
    ['貼った文字数ぶんの削除キー', '\x7f'.repeat(12)],
  ])('貼った依頼を %s で消してから別案件の画面で打った依頼は、依頼時点を更新し貼った依頼を送られなかった扱いにする', (_label, clear) => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted('a')) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b') });
    handleTerminalInput(clear, { focus, inbox });
    handleTerminalInput('冒頭を詰めて\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('b');
    expect(inbox.supersedePasted).toHaveBeenCalledTimes(1);
    expect(inbox.markPastedSubmitted).not.toHaveBeenCalled();
  });
  it('貼った依頼に書き足して別案件の画面で送ると、送られた扱いにするが依頼時点は別案件へ動かさない（Codex P2）', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted('a')) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b') });
    handleTerminalInput('もっと派手に', { focus, inbox });
    handleTerminalInput('\x7f\x7f', { focus, inbox });
    handleTerminalInput('\r', { focus, inbox });
    expect(focus.request()).toBeNull();
    expect(inbox.markPastedSubmitted).toHaveBeenCalledTimes(1);
    expect(inbox.supersedePasted).not.toHaveBeenCalled();
    // 送った後は送信待ちが無い。AI の確かめに文字で答えた Enter で、今の画面の案件が依頼時点になる（行き止まりにしない）
    inbox.pendingPasted.mockReturnValue(pasted());
    handleTerminalInput('はい\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('b');
  });
  it('貼った依頼を消した後に文字の無い Enter を挟んでも、消した記録は残る（Codex 再レビュー P2）', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted('a')) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b') });
    handleTerminalInput('\x15', { focus, inbox });
    handleTerminalInput('\r', { focus, inbox });
    expect(inbox.markPastedSubmitted).not.toHaveBeenCalled();
    handleTerminalInput('冒頭を詰めて\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('b');
    expect(inbox.supersedePasted).toHaveBeenCalledTimes(1);
    expect(inbox.markPastedSubmitted).not.toHaveBeenCalled();
  });
  it('消したかどうかの数え方は、新しく貼った依頼ごとにやり直す', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted('a')) };
    const focus = new AiFocusRegistry(() => 1000, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b') });
    handleTerminalInput('\x15', { focus, inbox });
    inbox.pendingPasted.mockReturnValue([{ id: 'inst-9', projectId: 'a', textLength: 12 }]);
    handleTerminalInput('足す\r', { focus, inbox });
    expect(focus.request()).toBeNull();
    expect(inbox.markPastedSubmitted).toHaveBeenCalledTimes(1);
    expect(inbox.supersedePasted).not.toHaveBeenCalled();
  });
  it('文字を打った Enter は毎回依頼時点を更新し、文字の無い Enter（許可の確認）は動かさない', () => {
    const inbox = { markPastedSubmitted: vi.fn(() => []), supersedePasted: vi.fn(() => []), pendingPasted: vi.fn(() => pasted()) };
    let now = 1000;
    const focus = new AiFocusRegistry(() => now, 15000);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    handleTerminalInput('\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('a');
    focus.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('b') });
    handleTerminalInput('\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('a');
    now = 2000;
    handleTerminalInput('冒', { focus, inbox });
    handleTerminalInput('頭\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('b');
    focus.beat({ pageId: 'page-aaaa', seq: 3, screen: screen('c') });
    handleTerminalInput('\x1b[A\r', { focus, inbox });
    expect(focus.request()?.projectId).toBe('b');
  });
});
