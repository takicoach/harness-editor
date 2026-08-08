import { describe, it, expect } from 'vitest';
import { formatClock, formatSize, frameToSec, secToFrame, parseSecField } from './format';

describe('formatClock', () => {
  it('秒を m:ss に整形する', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(105)).toBe('1:45');
  });
  it('負値は 0:00 にクランプする', () => {
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('frameToSec', () => {
  it('30fps の 45 フレームは 1.5 秒', () => { expect(frameToSec(45, 30)).toBeCloseTo(1.5); });
  it('fps=0 は 0 を返す（ゼロ除算回避）', () => { expect(frameToSec(45, 0)).toBe(0); });
});

describe('secToFrame', () => {
  it('30fps の 1.5 秒は 45 フレーム', () => { expect(secToFrame(1.5, 30)).toBe(45); });
  it('端数は最も近いフレームへ丸める', () => { expect(secToFrame(1.51, 30)).toBe(45); });
  it('fps=0 は 0 を返す', () => { expect(secToFrame(1.5, 0)).toBe(0); });
  it('frameToSec の逆変換でフレームが保たれる', () => {
    expect(secToFrame(frameToSec(123, 30), 30)).toBe(123);
  });
});

describe('parseSecField', () => {
  it('空文字は null', () => { expect(parseSecField('', 45, 30)).toBeNull(); });
  it('非数値は null', () => { expect(parseSecField('abc', 45, 30)).toBeNull(); });
  it('無編集 blur（46f@30fps の表示 "1.53"）は null＝幻の履歴を積まない', () => {
    expect(parseSecField('1.53', 46, 30)).toBeNull(); // secToFrame(1.53,30)=46
  });
  it('同じフレームへ丸まる等価表記 "1.54" も null', () => {
    expect(parseSecField('1.54', 46, 30)).toBeNull(); // secToFrame(1.54,30)=46
  });
  it('本当に違うフレームへ動かす入力はそのフレームを返す', () => {
    expect(parseSecField('2.00', 46, 30)).toBe(60);
  });
});

describe('formatSize', () => {
  it('MB 単位で整形する', () => {
    expect(formatSize(96 * 1024 * 1024)).toBe('96 MB');
    expect(formatSize(Math.round(1.5 * 1024 * 1024))).toBe('1.5 MB');
  });
  it('1MB 未満は KB', () => {
    expect(formatSize(2048)).toBe('2 KB');
  });
  it('0 バイトは —', () => {
    expect(formatSize(0)).toBe('—');
  });
});
