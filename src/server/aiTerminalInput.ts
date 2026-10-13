/**
 * 端末への入力の記録（AI タブの土台）。送信（Enter）の瞬間の主画面の状況を「依頼時点」にし、
 * 入力欄に貼ってあったボタンの依頼を「作業中」にする。
 */
import { aiFocus, type AiFocusRegistry } from './aiFocus';
import { instructionInbox, type InstructionInbox } from './instructionInbox';

const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;
/** 入力が送信（Enter）を含むか。貼り付けの中の改行と、Alt+Enter（ESC CR＝改行の入力）は送信に数えない。 */
export function submitsInput(data: string): boolean {
  const typed = data.replace(BRACKETED_PASTE, '');
  for (let index = 0; index < typed.length; index += 1) if (typed[index] === '\r' && typed[index - 1] !== '\x1b') return true;
  return false;
}
export interface TerminalInputDeps {
  focus: Pick<AiFocusRegistry, 'noteSubmit' | 'request' | 'primary'>;
  inbox: Pick<InstructionInbox, 'markPastedSubmitted' | 'pendingPasted' | 'supersedePasted'>;
}
/**
 * 端末の入力を受けた時に呼ぶ（pty へ書いた後）。
 * Enter は許可の確認・信頼の確認・空の Enter でも届くので、どれでも依頼扱いにはしない。
 * - 送信待ちのボタンの依頼がある: 主画面がその依頼の案件の時だけ、依頼時点にして作業中にする。
 *   別の案件の画面で文字を伴う Enter は、貼った依頼を消して（Ctrl+U・Ctrl+C・本文の文字数以上の削除）から打った
 *   手の依頼なら依頼時点にし、貼った依頼は送られなかった扱いにする。消したと分からない時は、貼った依頼に書き足して
 *   送った可能性があるので、送られた扱い（作業中）にして依頼時点は動かさない（別案件への書き込みは AI に確かめさせる）。
 *   文字を伴わない Enter は何もしない。
 * - 送信待ちが無い: 依頼時点がまだ無い時、または前の送信から文字が打たれた Enter（手で打った依頼）の時に依頼時点にする。
 *   文字を伴わない Enter（許可の確認など）は、依頼時点を別案件へ広げない。
 */
const typedSinceSubmit = new WeakMap<object, boolean>();
/** 今の送信待ちの貼り付け（番号の並び）に対して、消す操作をしたか。新しく貼られたら数え直す。 */
const pasteEdits = new WeakMap<object, { key: string; erased: number; cleared: boolean }>();
function notePasteEdit(owner: object, pending: ReadonlyArray<{ id: string; textLength: number }>, data: string): boolean {
  const key = pending.map(item => item.id).join(','), previous = pasteEdits.get(owner);
  const edit = previous && previous.key === key ? previous : { key, erased: 0, cleared: false };
  const outside = data.replace(BRACKETED_PASTE, '');
  if (/[\x03\x15]/.test(outside)) edit.cleared = true;
  edit.erased += outside.match(/[\x7f\x08]/g)?.length ?? 0;
  if (edit.erased >= pending.reduce((sum, item) => sum + item.textLength, 0)) edit.cleared = true;
  pasteEdits.set(owner, edit);
  return edit.cleared;
}
const ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z~]|\x1b./g;
/** 入力に、文字（貼り付け含む）が含まれるか。制御文字・矢印などの操作は含めない。 */
function hasText(data: string): boolean {
  if (/\x1b\[200~[\s\S]+?\x1b\[201~/.test(data)) return true;
  return data.replace(BRACKETED_PASTE, '').replace(ESCAPE_SEQUENCE, '').replace(/[\x00-\x1f\x7f]/g, '').length > 0;
}
export function handleTerminalInput(data: string, deps: TerminalInputDeps = { focus: aiFocus, inbox: instructionInbox }): void {
  const typed = typedSinceSubmit.get(deps.focus) === true || hasText(data);
  const pending = deps.inbox.pendingPasted();
  const cleared = pending.length > 0 && notePasteEdit(deps.focus, pending, data);
  if (!submitsInput(data)) {
    if (typed) typedSinceSubmit.set(deps.focus, true);
    return;
  }
  typedSinceSubmit.set(deps.focus, false);
  if (pending.length > 0) {
    const current = deps.focus.primary()?.screen?.projectId ?? null;
    if (current !== null && pending.every(item => item.projectId === current)) {
      deps.focus.noteSubmit();
      deps.inbox.markPastedSubmitted();
    } else if (typed && cleared) {
      deps.focus.noteSubmit();
      deps.inbox.supersedePasted();
    } else if (typed) {
      deps.inbox.markPastedSubmitted();
    } else {
      return; // 文字の無い Enter は何も送らない。消した記録も残す（次の手の依頼を書き足しと取り違えない）
    }
    pasteEdits.delete(deps.focus);
    return;
  }
  if (typed || deps.focus.request() === null) deps.focus.noteSubmit();
}
