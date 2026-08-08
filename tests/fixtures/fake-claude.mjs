// e2e 用の偽 claude。起動バナーを出し、stdin をそのままエコーする。
process.stdout.write('FAKE-CLAUDE READY\r\n');
// 入力（直近32文字のローリングバッファ、チャンク境界をまたぐ "exit" も検出）に
// "exit" が来たら自死する。claude-terminal.spec.ts の exited→restart 回帰テスト
// （C-1）が pty を落とすために使う。既存テストの入力（"ping-123" 等）には
// "exit" を含まないため影響しない。
let buf = '';
process.stdin.on('data', (b) => {
  process.stdout.write(b);
  buf = (buf + b.toString()).slice(-32);
  if (buf.includes('exit')) process.exit(0);
});
// SIGTERM で綺麗に終了（サーバ close 時の kill 検証を邪魔しない）
process.on('SIGTERM', () => process.exit(0));
