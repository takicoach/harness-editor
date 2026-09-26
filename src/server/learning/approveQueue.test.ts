import { expect, it } from 'vitest';
import { createSerialQueue } from './approveQueue';

it('後の処理は前の処理が終わるまで始まらない（非同期の途中でも交互に混ざらない）', async () => {
  const run = createSerialQueue();
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = run(async () => { log.push('first:start'); await gate; log.push('first:end'); return 1; });
  const second = run(async () => { log.push('second:start'); return 2; });
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(['first:start']);
  release();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(log).toEqual(['first:start', 'first:end', 'second:start']);
});

it('前の処理が失敗しても次の処理は実行し、失敗はその呼び出し元にだけ返す', async () => {
  const run = createSerialQueue();
  const failed = run(async () => { throw new Error('boom'); });
  const next = run(async () => 'ok');
  await expect(failed).rejects.toThrow('boom');
  await expect(next).resolves.toBe('ok');
});
