import { describe, expect, it } from 'vitest';
import { hasBullets, toggleBullets } from './textBar';

describe('箇条書き', () => {
  it('行頭が全部「・」なら箇条書き', () => {
    expect(hasBullets('・一\n・二')).toBe(true);
    expect(hasBullets('・一\n二')).toBe(false);
    expect(hasBullets('')).toBe(false);
  });
  it('入れると全行の頭に「・」、切ると外す（空行はそのまま）', () => {
    expect(toggleBullets('一\n\n  二')).toBe('・一\n\n・二');
    expect(toggleBullets('・一\n• 二')).toBe('一\n二');
  });
});
