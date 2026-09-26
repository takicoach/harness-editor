/**
 * 退避先の案内を現地時刻の言い換えにする（サイクル 2 Minor）。
 * フォルダ名（UTC）はそのままで、画面の文だけを読める形にする。
 */
import { describe, it, expect } from 'vitest';
import { backupTimeLabel, parseBackupStamp } from './backupLabel';

describe('parseBackupStamp', () => {
  it('backupStamp 形式のフォルダ名を Date に戻す', () => {
    const d = parseBackupStamp('.sme/backup/2026-09-06T16-12-00-000Z');
    expect(d?.toISOString()).toBe('2026-09-06T16:12:00.000Z');
  });

  it('形式が違えば null', () => {
    expect(parseBackupStamp('.sme/backup/manual')).toBeNull();
    expect(parseBackupStamp('')).toBeNull();
  });
});

describe('backupTimeLabel', () => {
  it('現地時刻で「M月D日 HH:MM の控え」を作る', () => {
    const iso = '2026-09-06T16:12:00.000Z';
    const local = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${local.getMonth() + 1}月${local.getDate()}日 ${pad(local.getHours())}:${pad(local.getMinutes())} の控え`;
    expect(backupTimeLabel('.sme/backup/2026-09-06T16-12-00-000Z')).toBe(expected);
  });

  it('UTC の表記（T・Z）を画面へ出さない', () => {
    const label = backupTimeLabel('.sme/backup/2026-09-06T16-12-00-000Z');
    expect(label).not.toContain('Z');
    expect(label).not.toContain('T');
  });

  it('読めないフォルダ名なら null（呼び出し側が従来文言へ落とす）', () => {
    expect(backupTimeLabel('.sme/backup/xxx')).toBeNull();
  });
});
