import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPendingKeys } from '../../../core/slides/prompts';
import { slidesRequestText } from '../../../shared/agentPrompts';
import type { InstructionInput, InstructionRecord } from '../../../shared/types';
import { useEventChannel } from '../../eventBus';
import { fetchJson, putJsonPost } from '../../fetchJson';
import { focusAiTerminal } from '../../panels/aiTerminalFocus';
import { useAiPresence } from '../../useAiPresence';
import { slidesAiHealth, type SlidesAiRecord } from './aiHealth';
import type { SlidesRequestIntent } from './requestIntent';
import type { SlidesSessionHook } from './useSlidesSession';

/** スライドの依頼は「スライド:」で始まる（slidesRequestText）。同じ受け箱の動画の依頼とは混ぜない。 */
const isSlidesRecord = (record: InstructionRecord, projectId: string) => record.projectId === projectId && record.text.startsWith('スライド:');
const isNewer = (previous: SlidesAiRecord | null, next: InstructionRecord) =>
  !previous || next.createdAt > previous.createdAt || (next.id === previous.id && next.updatedAt >= previous.updatedAt);

/** AI の経路: 在席の確認・依頼の送信（つながっていないときは送らない）・最後の依頼の状態・止まったかどうか。 */
export function useSlidesAgent(projectId: string, session: SlidesSessionHook) {
  // 「AI が使えるか」は端末が起動していて MCP の接続が生きていること（受け箱の待機ではない）。
  const presence = useAiPresence(true);
  const connected = presence === null ? null : presence.connected;
  const [record, setRecord] = useState<SlidesAiRecord | null>(null), [lastIntent, setLastIntent] = useState<SlidesRequestIntent | null>(null);
  const [error, setError] = useState<string | null>(null), [now, setNow] = useState(() => Date.now()), [progressAt, setProgressAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false), sendingRef = useRef(false);
  const recordRef = useRef(record), connectedRef = useRef(connected);
  recordRef.current = record; connectedRef.current = connected;
  const receive = useCallback((message: unknown) => {
    const event = message as { type?: string; record?: InstructionRecord }, next = event.type === 'update' ? event.record : undefined;
    if (!next || !isSlidesRecord(next, projectId)) return;
    setRecord(previous => isNewer(previous, next) ? { id: next.id, status: next.status, reply: next.reply, createdAt: next.createdAt, updatedAt: next.updatedAt } : previous);
  }, [projectId]);
  useEventChannel('claude', receive, projectId);
  useEffect(() => {
    let alive = true;
    void fetchJson<{ messages: unknown[] }>(`/api/events/sync?${new URLSearchParams({ id: projectId, ch: 'claude' })}`)
      .then(body => { if (alive && Array.isArray(body.messages)) body.messages.forEach(receive); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, receive]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  // 生成の進み（構成案が届いた・ページができた・失敗した）を「動いている」印にする。
  const generation = session.state?.document.generation;
  const progressKey = generation ? `${generation.runId}:${generation.status}:${generation.outline.length}:${generation.pages.map(page => page.status).join(',')}` : '';
  useEffect(() => { if (progressKey) setProgressAt(Date.now()); }, [progressKey]);
  const send = useCallback(async (intent: SlidesRequestIntent) => {
    // 送信中の二重押しは受け付けない（別の依頼 ID で同じ生成が二重に走るため）。
    if (sendingRef.current) return;
    setLastIntent(intent); setError(null);
    // つながっていないときは送らない（あとで届いて手直しを上書きしないように）。欄が再接続か貼り付けを案内する。
    if (connectedRef.current !== true) return;
    sendingRef.current = true; setSending(true);
    const request: InstructionInput = { projectId, text: slidesRequestText(intent.kind, intent.keys), context: { frame: 0, timeSec: 0, selection: null },
      requestId: crypto.randomUUID(), requestCreatedAt: Date.now() };
    try {
      // 入力欄に貼るだけ。送るのは利用者の Enter（設計書 5）。
      receive({ type: 'update', record: await putJsonPost<InstructionRecord>('/api/ai/requests', request) });
      focusAiTerminal();
    }
    catch (cause) { setError(`AI の入力欄に貼れませんでした（${cause instanceof Error ? cause.message : String(cause)}）。AI の画面で AI が起動してから、もう一度押してください。貼り付けに切り替えても続けられます`); }
    finally { sendingRef.current = false; setSending(false); }
  }, [projectId, receive]);
  /** 作業中の依頼を打ち切る（受け箱の仕様で、AI がまだ受け取っていない依頼は打ち切れない）。 */
  const abort = useCallback(async () => {
    const current = recordRef.current;
    if (current?.status === 'processing') await putJsonPost('/api/instructions/abort', { id: current.id }).catch(() => undefined);
  }, []);
  /** 続きの依頼: 確定後は待ち・失敗のページ、確定前は最後の依頼（無ければ構成案）。 */
  const continueIntent = useCallback((): SlidesRequestIntent | null => {
    const document = session.readCurrent()?.document;
    if (!document) return null;
    if (document.generation?.confirmed) { const keys = nextPendingKeys(document); return keys.length ? { kind: 'pages', keys } : null; }
    return lastIntent ?? (document.script.paragraphs.length ? { kind: 'outline', keys: [] } : null);
  }, [session.readCurrent, lastIntent]);
  const health = slidesAiHealth({ connected, record, lastProgressAt: progressAt, now });
  // 貼った直後（Enter 待ち）だけ押せない。AI の作業中に押したら入力欄に貼るだけ（送る時機は利用者が決める）。
  const busy = sending || health.state === 'waiting';
  return { connected, record, error, lastIntent, health, busy, send, abort, continueIntent };
}
export type SlidesAgentHook = ReturnType<typeof useSlidesAgent>;
