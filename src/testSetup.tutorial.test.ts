import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('テスト中は新画面の初回チュートリアルを止め、監査が起こす子プロセスにも引き継ぐ', () => {
  expect(process.env['SME_TUTORIAL']).toBe('0');
  const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.SME_TUTORIAL))'], { encoding: 'utf8' });
  expect(child).toBe('0');
});
