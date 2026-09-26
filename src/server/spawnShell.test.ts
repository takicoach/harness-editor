import { describe, it, expect } from 'vitest';
import { quoteForCmdShell } from './spawnShell';

describe('quoteForCmdShell', () => {
  it('空白を含む引数を quote する（例: C:\\Users\\x\\My Videos）', () => {
    expect(quoteForCmdShell(['C:\\Users\\x\\My Videos\\out\\a.mp4'])).toEqual(['"C:\\Users\\x\\My Videos\\out\\a.mp4"']);
  });

  it('cmd 予約文字（& ( ) % 等）を含む空白なしパスも quote する', () => {
    expect(quoteForCmdShell(['C:\\pj\\R&D\\out\\a.mp4'])).toEqual(['"C:\\pj\\R&D\\out\\a.mp4"']);
    expect(quoteForCmdShell(['C:\\pj\\swing(2026)\\a.mp4'])).toEqual(['"C:\\pj\\swing(2026)\\a.mp4"']);
    expect(quoteForCmdShell(['C:\\pj\\50%off\\a.mp4'])).toEqual(['"C:\\pj\\50%off\\a.mp4"']);
    expect(quoteForCmdShell(['a^b', 'c|d', 'e<f>g', 'h!i', 'j;k', 'l=m'])).toEqual([
      '"a^b"', '"c|d"', '"e<f>g"', '"h!i"', '"j;k"', '"l=m"',
    ]);
  });

  it('安全な引数はそのまま通す', () => {
    expect(quoteForCmdShell(['remotion', 'render', 'MainVideo', 'C:\\pj\\out\\a.mp4'])).toEqual([
      'remotion', 'render', 'MainVideo', 'C:\\pj\\out\\a.mp4',
    ]);
  });
});
