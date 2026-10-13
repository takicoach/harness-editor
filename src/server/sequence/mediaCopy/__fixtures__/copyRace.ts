// 2つのプロセスで同じ完成名を取り合う試験（copyItem.test.ts）の子プロセス。引数: 元のファイル・フォルダー・dev・ino。
// 読み込みを終えたら「ready」の1行を書き、標準入力に何か届いてから始める（親が2つを同時に始めさせ、コピーの期間を重ねる）。
// 結果と、コピーの始まり・終わりの時刻（重なったことの証拠）を JSON で標準出力に書く。
import {once} from 'node:events';
import {copyOneItem} from '../copyItem';
import {nodeCopyIo} from '../io';

const [source,folder,dev,ino]=process.argv.slice(2);
process.stdout.write('ready\n');
await once(process.stdin,'data');
const startedAt=Date.now();
const result=await copyOneItem(nodeCopyIo,{path:source!},{folder:{path:folder!,dev:Number(dev),ino:Number(ino)},name:'clip.wav'},
  {signal:new AbortController().signal,phase:async()=>undefined,progress:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}});
process.stdout.write(JSON.stringify({...result,startedAt,endedAt:Date.now()}));
