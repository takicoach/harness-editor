// src/server/spawnShell.ts — npm/npx 等の子プロセス spawn 共通ヘルパ。
// Windows の npm/npx は .cmd のため shell 経由でないと起動できない
// （Node の CVE-2024-27980 対応で .cmd の直接 spawn は EINVAL になる）ロジックを
// renderJob.ts と backgroundInstall.ts の両方から使うため共通化。
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';

/** テスト容易性のため最小 subset に絞ったプロセスインターフェース。 */
export interface FakeProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals | number): boolean;
  pid?: number;
  unref?: () => void;
}

export interface SpawnCommandOptions {
  /** 実行するコマンド（npm / npx 等）。 */
  command: string;
  /** コマンドに渡す引数配列。 */
  args: string[];
  cwd?: string;
}

/**
 * cmd.exe（shell:true）向けの引数 quote。空白だけでなく cmd の予約文字
 * （& | < > ( ) ^ % ! , ; =）を含む引数も quote しないと、`R&D` や `swing(2026)` の
 * ようなフォルダ名で render コマンドが壊れる（別コマンド連結・文法エラー・変数展開）。
 * 残余リスク: %VAR% は cmd の quote 内でも展開されうる（該当パスは実運用では稀）。
 */
export function quoteForCmdShell(args: string[]): string[] {
  return args.map((a) => (/[\s&|<>()^%!,;=]/.test(a) ? `"${a}"` : a));
}

/**
 * npm/npx 等のコマンドを spawn する。Windows は shell:true + quote、POSIX は
 * プロセスグループ kill（killGroup）用に detach。
 */
export function spawnCommand({ command, args, cwd }: SpawnCommandOptions): FakeProcess {
  const useShell = process.platform === 'win32';
  const shellArgs = useShell ? quoteForCmdShell(args) : args;
  return nodeSpawn(command, shellArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !useShell,
    shell: useShell,
    windowsHide: true,
  }) as unknown as FakeProcess;
}
