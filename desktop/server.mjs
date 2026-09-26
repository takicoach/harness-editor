import {createServer} from 'vite';
import {createServer as createSocketServer} from 'node:net';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
const root = process.cwd();
const cache = process.env.HARNESS_DESKTOP_CACHE;
if (!cache || !process.env.HARNESS_PROJECT_ROOT) throw new Error('Desktop directories are required');
await mkdir(cache, {recursive:true});
await mkdir(process.env.HARNESS_PROJECT_ROOT, {recursive:true});
const port=Number(process.env.HARNESS_DESKTOP_PORT||0)||await new Promise((accept,reject)=>{
  const probe=createSocketServer();probe.once('error',reject);
  probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(error=>error?reject(error):accept(port));});
});
// configLoader は 'native'（このプロセスは --import tsx で起動しているので vite.config.ts を素の Node で読める）。
// 'runner' は設定を読み終えた直後に Vite が module runner を閉じるため、設定経由で読み込まれた
// src/server/*.ts の後からの動的 import（ptySession.ts の node-pty、captureDriver.ts の playwright-core）が
// 「Vite module runner has been closed.」で失敗する（2026-09-21・server.test.mjs が回帰検査）。
// 'bundle' は vite.config.ts の隣に一時ファイルを書くのでアプリ同梱物の中では避ける。
const server = await createServer({
  root, configFile:join(root,'vite.config.ts'), configLoader:'native', cacheDir:cache,
  server:{host:'127.0.0.1',port,strictPort:true,open:false,hmr:false,watch:null},
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const deadline = setTimeout(()=>process.exit(1),5000); deadline.unref();
  await server.close(); process.exit(0);
}
process.on('message', message => { if (message === 'shutdown') void close(); });
process.on('disconnect',()=>void close());
process.on('SIGTERM',()=>void close());
process.on('SIGINT',()=>void close());
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('No local server address');
process.send?.({type:'ready',origin:`http://127.0.0.1:${address.port}`});
