// e2e 用の偽 codex。起動バナーを出し、stdin をそのままエコーする。
// 契約は fake-claude.mjs と同じ（バナー文字列だけが違う）。
process.stdout.write('FAKE-CODEX READY\r\n');
let buf = '';
process.stdin.on('data', (b) => {
  process.stdout.write(b);
  buf = (buf + b.toString()).slice(-32);
  if (buf.includes('exit')) process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
