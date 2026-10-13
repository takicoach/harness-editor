import { describe, expect, it } from 'vitest';
import { SLIDES_AI_STALL_MS, slidesAiHealth, type SlidesAiRecord } from './aiHealth';

const NOW = 1_800_000_000_000;
const record = (status: SlidesAiRecord['status'], updatedAt = NOW - 60_000, reply: string | null = null): SlidesAiRecord => ({ id: 'i1', status, reply, createdAt: updatedAt, updatedAt });
const health = (connected: boolean | null, item: SlidesAiRecord | null, lastProgressAt: number | null = null) => slidesAiHealth({ connected, record: item, lastProgressAt, now: NOW });

describe('AI の作業の状態と案内', () => {
  it('つながりの確認中・待機中', () => {
    expect(health(null, null)).toMatchObject({ state: 'checking', actions: [] });
    expect(health(true, null)).toMatchObject({ state: 'idle', actions: [] });
  });
  it('つながっていないときは、AI の画面を見るか、貼り付けへの切り替えを出す（設定ファイルの手直しは求めない）', () => {
    const offline = health(false, null);
    expect(offline).toMatchObject({ state: 'offline', actions: ['reconnect', 'paste'] });
    expect(offline.message).not.toMatch(/設定ファイル|json|config|待機/i);
    expect(health(false, record('pending')).message).toContain('頼み直してください');
  });
  it('送信待ち（入力欄に貼った）・作業中。5 分以上進まなければ「止まっている」。送信待ちは止まった扱いにしない', () => {
    expect(health(true, record('pending'))).toMatchObject({ state: 'waiting', actions: [], message: expect.stringContaining('Enter で送って') });
    expect(health(true, record('processing'))).toMatchObject({ state: 'working', actions: [] });
    const old = NOW - SLIDES_AI_STALL_MS - 1;
    expect(health(true, record('processing', old), old)).toMatchObject({ state: 'stalled', actions: ['reconnect', 'resume', 'paste'] });
    expect(health(true, record('processing', old), NOW - 60_000)).toMatchObject({ state: 'working' });
    expect(health(true, record('pending', old), old)).toMatchObject({ state: 'waiting' });
  });
  it('止まった（失敗）・終わった', () => {
    expect(health(true, record('failed', NOW, '利用枠を使い切りました'))).toMatchObject({ state: 'failed', actions: ['resume', 'paste'], message: expect.stringContaining('利用枠を使い切りました') });
    expect(health(false, record('failed'))).toMatchObject({ state: 'failed', actions: ['reconnect', 'paste'] });
    expect(health(true, record('done', NOW, '6 ページ作りました'))).toMatchObject({ state: 'done', message: expect.stringContaining('6 ページ作りました') });
  });
});
