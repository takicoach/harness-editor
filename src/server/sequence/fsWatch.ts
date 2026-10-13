import {homedir} from 'node:os';
import {sep} from 'node:path';

/**
 * ファイルを開く・読む処理の見張り（2026-10-06: 起動後に読み取りが open() で固まり、書き出し前の確認が返らなかった。
 * 作業用スレッドが open() で止まっていたことまでは分かったが、どのパスかは記録に無かった）。
 *
 * - 診断: FS_REPORT_MS を過ぎても戻らない処理は、パスと待ち時間を `[sme]` の記録に1回出す（遅れて戻った時にもう1回）。
 * - 防御: limitMs を渡した待ち手は、その長さで待つのをやめて UnresponsiveFileError で失敗する。Node の open/read は取り消せないので、
 *   処理そのものは残る。遅れて戻った値は dispose で片付ける（開いたハンドルを閉じる）。
 * - 積み重ねない: 同じ処理・同じパスで UNRESPONSIVE_READ_MS（または limitMs）を過ぎても戻らないものがあれば、新しく呼ばずにすぐ失敗する
 *   （止まった処理を足し続けて作業用スレッドを使い切らない。references.ts の裏の照合の「止まった読みは積み重ねない」と同じ考え）。
 */
/** 外付け HDD の回転待ち（数秒〜十数秒）より長く、利用者があきらめる前に記録が残る長さ。 */
export const FS_REPORT_MS=15_000;
/** 応答しないとみなす長さ。裏の照合の見張り（references.ts の STALL_MS）と同じ 60 秒: 裏の照合が待てる媒体を、書き出し前の確認が先に見限らない。 */
export const UNRESPONSIVE_READ_MS=60_000;
/** 書き出し前の確認が渡す待ちの上限。無ければ従来どおり待つ（記録だけ出す）。 */
export interface ReadLimit {unresponsiveMs?:number}
export type FsOperation='open'|'read'|'stat'|'realpath'|'readFile';
const verbs:Record<FsOperation,string>={open:'開く',read:'読む',stat:'情報を得る',realpath:'実際の場所を確かめる',readFile:'読む'};

export class UnresponsiveFileError extends Error{
  readonly code='ETIMEDOUT';
  constructor(readonly operation:FsOperation,readonly path:string,readonly waitedMs:number){
    super(`ファイルを${verbs[operation]}処理が応答しません`);this.name='UnresponsiveFileError';
  }
}
interface Pending {operation:FsOperation;path:string;startedAt:number}
const pending=new Set<Pending>();
const seconds=(ms:number)=>(ms/1000).toFixed(1);

/** 試験専用: reportMs は記録までの長さ（試験で縮める）。pending は戻っていない処理の一覧。 */
export const fsWatchTesting={reportMs:FS_REPORT_MS,pending:()=>[...pending].map(call=>({...call}))};

export function watchedFs<T>(operation:FsOperation,path:string,call:()=>Promise<T>,options:{limitMs?:number;dispose?:(value:T)=>unknown}={}):Promise<T>{
  const {limitMs,dispose}=options,stuckAfter=limitMs??UNRESPONSIVE_READ_MS,now=Date.now();
  for(const other of pending)if(other.operation===operation&&other.path===path&&now-other.startedAt>=stuckAfter)
    return Promise.reject(new UnresponsiveFileError(operation,path,now-other.startedAt));
  let work:Promise<T>;
  try{work=call();}catch(error){return Promise.reject(error);}
  const entry:Pending={operation,path,startedAt:now};pending.add(entry);
  let reported=false,abandoned=false;
  const report=setTimeout(()=>{
    reported=true;console.warn(`[sme] ファイルを${verbs[operation]}処理（${operation}）が ${seconds(Date.now()-entry.startedAt)} 秒戻りません:`,path);
  },fsWatchTesting.reportMs);
  report.unref?.();
  const settle=()=>{
    pending.delete(entry);clearTimeout(report);
    if(reported)console.warn(`[sme] ファイルを${verbs[operation]}処理（${operation}）が ${seconds(Date.now()-entry.startedAt)} 秒後に戻りました:`,path);
  };
  work.then(value=>{settle();if(abandoned&&dispose)void Promise.resolve().then(()=>dispose(value)).catch(()=>undefined);},settle);
  if(limitMs===undefined)return work;
  return new Promise<T>((resolve,reject)=>{
    const timer=setTimeout(()=>{abandoned=true;reject(new UnresponsiveFileError(operation,path,limitMs));},limitMs);
    work.then(value=>{if(abandoned)return;clearTimeout(timer);resolve(value);},error=>{if(abandoned)return;clearTimeout(timer);reject(error);});
  });
}

/** 利用者に見せる場所（パス全体は見せない: 書き出し前の確認の結果に絶対パスを載せない既存の約束）。 */
export function fileLocationLabel(path:string):string{
  const volume=/^\/Volumes\/([^/]+)/.exec(path);if(volume)return `ドライブ「${volume[1]}」`;
  const home=homedir();
  if(path.startsWith(home+sep)){const folder=path.slice(home.length+1).split(sep)[0];return folder?`ホームの「${folder}」`:'ホーム';}
  return 'このMacのディスク';
}
export function unresponsiveReadMessage(path:string):string{return `読み込みが応答しません（${fileLocationLabel(path)}）。ドライブの接続を確かめてください。`;}
