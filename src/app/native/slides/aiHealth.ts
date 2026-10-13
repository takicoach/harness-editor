import type { InstructionStatus } from '../../../shared/types';

/** 作業中のまま、この時間なにも進まなければ「止まっている」とみなす。 */
export const SLIDES_AI_STALL_MS = 5 * 60 * 1000;
export type SlidesAiAction = 'reconnect' | 'resume' | 'paste';
export interface SlidesAiRecord { id: string; status: InstructionStatus; reply: string | null; createdAt: number; updatedAt: number }
export interface SlidesAiHealth { state: 'checking' | 'idle' | 'offline' | 'waiting' | 'working' | 'stalled' | 'failed' | 'done'; message: string; actions: SlidesAiAction[] }
/**
 * AI の欄に出す状態と案内。lastProgressAt は生成の進み（構成案が届いた・ページができた等）を見た時刻。
 * 止まったときの戻り方は画面の操作だけ（再接続・続きから作る・貼り付けに切り替える）にし、設定ファイルの手直しは求めない。
 */
export function slidesAiHealth(input: { connected: boolean | null; record: SlidesAiRecord | null; lastProgressAt: number | null; now: number }): SlidesAiHealth {
  const { connected, record, now } = input, active = !!record && (record.status === 'pending' || record.status === 'processing');
  if (record?.status === 'failed') return { state: 'failed', message: `AI の作業が止まりました（${record.reply ?? '理由は返っていません'}）。作った分は保存されています。`,
    actions: connected === false ? ['reconnect', 'paste'] : ['resume', 'paste'] };
  if (connected === false) return { state: 'offline', actions: ['reconnect', 'paste'], message: active
    ? 'AI がつながっていません。AI の画面で起動を確かめてください。貼った依頼は、AI が起動し直したら頼み直してください。'
    : 'AI がつながっていません。下の AI の画面で起動を確かめるか、「貼り付けに切り替える」で続けてください。' };
  if (record && active) {
    if (record.status === 'pending') return { state: 'waiting', message: 'AI の入力欄に依頼を貼りました。確かめて Enter で送ってください。', actions: [] };
    if (now - Math.max(record.updatedAt, input.lastProgressAt ?? 0) > SLIDES_AI_STALL_MS)
      return { state: 'stalled', message: '5 分以上進んでいません。利用枠を使い切ったか、接続が切れた可能性があります。作った分は保存されています。', actions: ['reconnect', 'resume', 'paste'] };
    return { state: 'working', message: 'AI が作業中です。進み具合は左の「台本から作る」に出ます。', actions: [] };
  }
  if (connected === null) return { state: 'checking', message: 'AI の接続を確かめています。', actions: [] };
  if (record?.status === 'done') return { state: 'done', message: `AI の作業が終わりました${record.reply ? `（${record.reply}）` : ''}。`, actions: [] };
  return { state: 'idle', message: 'AI はつながっています。左の「台本から作る」から頼めます（依頼は AI の入力欄に貼られます）。', actions: [] };
}
