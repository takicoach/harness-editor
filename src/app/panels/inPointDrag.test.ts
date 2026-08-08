import { describe, expect, it, vi } from 'vitest';
import { commitInPointDrag } from './inPointDrag';

describe('commitInPointDrag', () => {
  it('commit 前に pre-drag のイン点へ復元してから final を積む（onLive→onCommit の順）', () => {
    const calls: string[] = [];
    const onLive = vi.fn((f: number) => calls.push(`live:${f}`));
    const onCommit = vi.fn((f: number) => calls.push(`commit:${f}`));

    commitInPointDrag(100, 130, { onLive, onCommit });

    // まず pre-drag(100) へ復元 → その後 final(130) を 1 件積む。
    expect(calls).toEqual(['live:100', 'commit:130']);
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('値が変わらない（無移動）なら復元のみで履歴を積まない', () => {
    const onLive = vi.fn();
    const onCommit = vi.fn();

    commitInPointDrag(100, 100, { onLive, onCommit });

    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onLive).toHaveBeenCalledWith(100);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
