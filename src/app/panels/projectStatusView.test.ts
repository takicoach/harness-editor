import { describe, it, expect } from 'vitest';
import { resolveStatusView, formatRelativeTime, statusLabel } from './projectStatusView';

describe('statusLabel', () => {
  it('各ステータスに日本語ラベルを返す', () => {
    expect(statusLabel('idle')).toBe('未着手');
    expect(statusLabel('transcribe')).toBe('文字起こし');
    expect(statusLabel('cut')).toBe('カット');
    expect(statusLabel('telop')).toBe('テロップ');
    expect(statusLabel('audio')).toBe('SE・BGM');
    expect(statusLabel('rendered')).toBe('書き出し済');
  });
});

describe('resolveStatusView', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');

  it('activity が無ければ status のラベル・クラスを返す', () => {
    const v = resolveStatusView({ status: 'telop' }, now);
    expect(v.label).toBe('テロップ');
    expect(v.className).toContain('status-telop');
    expect(v.colorClass).toBe('status-telop');
    expect(v.spinner).toBe(false);
  });

  it('activity ありは工程名を最優先で表示しスピナーを回す', () => {
    const v = resolveStatusView(
      { status: 'cut', activityLabel: 'カット中', activityStartedAt: new Date(now - 5 * 60 * 1000).toISOString() },
      now,
    );
    expect(v.label).toBe('カット中');
    expect(v.spinner).toBe(true);
    expect(v.className).toContain('status-activity');
  });

  it('activityStartedAt が2時間を超過している場合、now を渡した時点で stale と判定される（クライアント自前判定）', () => {
    const startedAt = new Date(now - (2 * 60 * 60 * 1000 + 1)).toISOString();
    const v = resolveStatusView({ status: 'cut', activityLabel: 'テロップ挿入中', activityStartedAt: startedAt }, now);
    expect(v.label).toBe('テロップ挿入中（中断?）');
    expect(v.spinner).toBe(false);
    expect(v.className).toContain('status-stale');
  });

  it('activityStartedAt が2時間以内なら stale ではない（サーバーの activityStale=true を無視し自前判定を優先する）', () => {
    const startedAt = new Date(now - 30 * 60 * 1000).toISOString();
    const v = resolveStatusView(
      { status: 'cut', activityLabel: 'テロップ挿入中', activityStartedAt: startedAt, activityStale: true },
      now,
    );
    expect(v.label).toBe('テロップ挿入中');
    expect(v.spinner).toBe(true);
  });

  it('activityStartedAt が解析不能なら stale 扱いにしない', () => {
    const v = resolveStatusView({ status: 'cut', activityLabel: '処理中', activityStartedAt: 'invalid' }, now);
    expect(v.spinner).toBe(true);
    expect(v.label).toBe('処理中');
  });

  it('activityLabel が空文字なら status にフォールバック', () => {
    const v = resolveStatusView({ status: 'idle', activityLabel: '' }, now);
    expect(v.label).toBe('未着手');
    expect(v.spinner).toBe(false);
  });

  it('書き出し済み + activity では activity が優先される', () => {
    const v = resolveStatusView(
      { status: 'rendered', activityLabel: '再書き出し中', activityStartedAt: new Date(now - 1000).toISOString() },
      now,
    );
    expect(v.label).toBe('再書き出し中');
    expect(v.spinner).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');

  it('1 分未満は「たった今」', () => {
    expect(formatRelativeTime(now - 30 * 1000, now)).toBe('たった今');
  });

  it('未来・負値は「たった今」', () => {
    expect(formatRelativeTime(now + 5000, now)).toBe('たった今');
  });

  it('分単位', () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000, now)).toBe('5分前');
  });

  it('時間単位', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000, now)).toBe('3時間前');
  });

  it('昨日', () => {
    expect(formatRelativeTime(now - 30 * 60 * 60 * 1000, now)).toBe('昨日');
  });

  it('日単位', () => {
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, now)).toBe('3日前');
  });

  it('7 日超は同年なら M/D', () => {
    const ms = Date.parse('2026-06-01T00:00:00Z');
    expect(formatRelativeTime(ms, now)).toMatch(/^\d{1,2}\/\d{1,2}$/);
  });

  it('7 日超で年が違えば YYYY/M/D', () => {
    const ms = Date.parse('2025-01-01T00:00:00Z');
    expect(formatRelativeTime(ms, now)).toMatch(/^2025\/\d{1,2}\/\d{1,2}$/);
  });
});
