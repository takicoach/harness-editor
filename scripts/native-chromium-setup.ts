import {appendFile,mkdir,rename,realpath,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {installNativeChrome} from '../src/server/installNativeChrome';
const controller=new AbortController();
const cancel=()=>controller.abort(new Error('native-browser-setup-cancelled'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
let log:string|undefined;
try {
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--archive'))throw new Error('usage: native-chromium-setup.ts [--archive private.zip]');
  const root=await realpath(process.cwd()),tools=join(root,'tools');await mkdir(tools,{recursive:true});
  if((await lstat(tools)).isSymbolicLink()||await realpath(tools)!==tools)throw new Error('unsafe-tools-directory');
  log=join(tools,'native-chromium-setup.log');
  try {await rename(log,`${log}.1`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await appendFile(log,`${new Date().toISOString()} native full Chrome setup\n`);
  const result=await installNativeChrome({editorRoot:root,...(args[1]?{archive:args[1]}:{}),signal:controller.signal});
  await appendFile(log,`OK ${JSON.stringify(result)}\n`);process.stdout.write(`OK 独自書き出し用ブラウザ: ${result.bin}\n`);
} catch(error){
  process.exitCode=1;const message=error instanceof Error?error.stack??error.message:String(error);
  if(log)await appendFile(log,`${message}\n`).catch(()=>{});
  process.stderr.write('独自書き出し用ブラウザの導入に失敗しました。setup を再実行してください。記録: tools/native-chromium-setup.log\n');
} finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
