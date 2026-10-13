import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,rename,rm,unlink,writeFile,type FileHandle} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import type {Rational} from '../../core/sequence/time';
import type {ByteSource} from '../../preview/native/mp4FrameSource';
import {mp4EditTimeline,mp4SampleTimeline,readMp4Movie} from '../../preview/native/mp4Timeline';
import {videoOnlyMp4Bytes} from '../../preview/native/videoOnlyMp4Bytes';
import {resolveFfprobeBin} from '../resolveFfmpeg';
import {openSequenceAsset,type SequenceAssetLease} from './assets';
import {cacheDirectory,run} from './media';
import {SharedPreparations} from './sharedPreparation';
import {withFfmpegSlot} from './ffmpegGate';

/**
 * 設計 §2-1: 原本の明示したストリームのフレームを表示順に並べた索引。軽量版からは作らない。
 * - 選ぶ: pts（timeBase の整数）は素材時刻でのフレームの表示開始（frameAtTime 用）。MP4 は書き出しの復号器（mp4Timeline）と同じ定義なので、
 *   編集リストの開始をまたぐフレームは編集開始から表示される。
 * - 取り出す: decodePts（streamTimeBase の整数）は FFmpeg がそのフレームに付ける pts、decodeFrom は復号を始めるキーフレームの時刻。
 *   ignoreEditList の時は編集リストを無視した読み方の値（またぐフレームも取り出せる）。startMicroseconds はその読み方での入力の開始時刻。
 */
export interface FramePresentation {version:3;timeBase:{num:number;den:number};pts:number[];streamTimeBase:{num:number;den:number};decodePts:number[];decodeFrom:number[];startMicroseconds:number;ignoreEditList:boolean}
/** 作り方の版。変えたら古いキャッシュは全て作り直す（frameImages の初回の掃除が他の版のフォルダーを消す）。
 * 索引を作り直した時は、その s<n>/ の下のコマだけを消す（framePresentationIndex）。 */
export const FRAME_CACHE_VERSION='frames-v1';
/** 確定値は事前の測定で決めた。 */
export const FRAME_DECODER_THREADS=2;
const FRAME_INDEX_MAX_OUTPUT=256*1024*1024;
export function parseMicroseconds(text:string):number{
  const match=/^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());if(!match)throw new Error('素材の開始時刻を確認できません');
  const value=Number(match[2])*1e6+Number((match[3]??'').padEnd(6,'0'));if(!Number.isSafeInteger(value))throw new Error('素材の開始時刻を確認できません');
  return match[1]?-value:value;
}
interface DecodeUnit {pts:number;from:number;key:boolean}
/** 復号順の各フレームの、復号を始めるキーフレームの時刻: 復号順で手前の最後のキーフレーム。表示がそれより前のもの（開いた GOP の先行フレーム）は一つ前のキーフレーム。 */
function decodeStarts(units:readonly DecodeUnit[]):number[]{
  let last=-1,previous=-1;
  return units.map((unit,index)=>{
    if(unit.key){previous=last;last=index;}
    return units[last<0?0:unit.pts<units[last]!.pts&&previous>=0?previous:last]!.from;
  });
}
function timeBaseOf(text:string):{num:number;den:number}{
  const match=/^(\d+)\/(\d+)$/.exec(text);if(!match||!Number(match[1])||!Number(match[2]))throw new Error('映像の時間単位を確認できません');
  return {num:Number(match[1]),den:Number(match[2])};
}
const INTEGER=/^-?\d+$/;
/** `ffprobe -of csv=p=1` の "packet,<pts>,<dts>,<flags>"（復号順）・"stream,<time_base>"・"format,<start_time>"。
 * D（編集リストで捨てる先頭）は表示されないので並べないが、復号の起点には使う。dts の無い容器はキーフレームの pts から復号する。 */
export function parseFramePresentation(output:string):FramePresentation{
  let timeBase:{num:number;den:number}|undefined,start:number|undefined;const units:Array<DecodeUnit&{shown:boolean}>=[];
  for(const line of output.split('\n')){
    const [section,a='',b='',c='']=line.trim().split(',');
    if(section==='stream')timeBase=timeBaseOf(a);
    else if(section==='format')start=a==='N/A'?0:parseMicroseconds(a);
    else if(section==='packet'){
      if(!INTEGER.test(a))throw new Error('映像フレームの時刻を確認できません');
      const pts=Number(a);units.push({pts,from:INTEGER.test(b)?Math.min(pts,Number(b)):pts,key:c.includes('K'),shown:!c.includes('D')});
    }
  }
  if(!timeBase||start===undefined||!units.some(unit=>unit.shown))throw new Error('映像フレームの索引を作れません');
  const starts=decodeStarts(units),frames=units.map((unit,index)=>({pts:unit.pts,from:starts[index]!,shown:unit.shown})).filter(frame=>frame.shown).sort((x,y)=>x.pts-y.pts);
  for(let i=1;i<frames.length;i++)if(frames[i]!.pts===frames[i-1]!.pts)throw new Error('映像フレームの時刻が重複しています');
  const pts=frames.map(frame=>frame.pts);
  return {version:3,timeBase,pts,streamTimeBase:timeBase,decodePts:[...pts],decodeFrom:frames.map(frame=>frame.from),startMicroseconds:start,ignoreEditList:false};
}
/** 表示時刻がその時刻以下で最大のフレーム。最初より前は最初、最後より後は最終フレーム（素材の終端を越える時刻）。 */
export function frameAtTime(index:FramePresentation,time:Rational):number{
  if(time.num<0)return 0;
  const limit=BigInt(time.num)*BigInt(index.timeBase.den)/(BigInt(index.timeBase.num)*BigInt(time.den)),pts=index.pts;
  if(limit<BigInt(pts[0]!))return 0;
  if(limit>=BigInt(pts[pts.length-1]!))return pts.length-1;
  const target=Number(limit);let low=0,high=pts.length-1;
  while(low<high){const mid=(low+high+1)>>1;if(pts[mid]!<=target)low=mid;else high=mid-1;}
  return low;
}
/** 切り出しのシーク位置（µs）: 復号を始めるキーフレームの時刻を切り捨て、入力の開始時刻を引く（FFmpeg は -ss に開始時刻を足す）。
 * 不正確シークなので復号はそのキーフレームか、それより前から始まる。目的のフレームは frameExtractionArgs が pts の一致で選ぶ。 */
export function frameSeekMicroseconds(index:FramePresentation,frame:number):number{
  const from=index.decodeFrom[frame];if(from===undefined)throw new Error('フレーム番号が範囲外です');
  const numerator=BigInt(from)*BigInt(index.streamTimeBase.num)*1000000n,denominator=BigInt(index.streamTimeBase.den);
  const floor=numerator>=0n?numerator/denominator:-((-numerator+denominator-1n)/denominator);
  return Math.max(0,Number(floor)-index.startMicroseconds);
}
export const seekArgument=(us:number)=>`${Math.floor(us/1e6)}.${String(us%1e6).padStart(6,'0')}`;
/**
 * 1コマを取り出す FFmpeg の引数（Task 7 の切り出しはこれをそのまま使う）。明示ストリーム、表示の向き（自動回転）、正方画素、JPEG。
 * 正確シーク（-ss の後の最初のフレーム）は B フレームのある素材でキーフレーム直前のフレームを飛ばす（そのキーフレームの dts が
 * 直前のフレームの pts と同じで、復号がキーフレームから始まる）。そこで復号は手前のキーフレームから始め（不正確シーク）、
 * 時刻は付け直さず（-copyts）、目的のフレームは pts の一致で選ぶ。trim はその pts を過ぎたら復号を止める
 * （合うフレームが無い時に素材の最後まで復号しない）。
 */
export function frameExtractionArgs(index:FramePresentation,frame:number,streamIndex:number,height:number,output:string):string[]{
  const pts=index.decodePts[frame];if(pts===undefined)throw new Error('フレーム番号が範囲外です');
  return ['-hide_banner','-loglevel','error','-nostdin','-threads',String(FRAME_DECODER_THREADS),'-fd','3',...(index.ignoreEditList?['-ignore_editlist','1']:[]),
    '-noaccurate_seek','-ss',seekArgument(frameSeekMicroseconds(index,frame)),'-copyts','-i','fd:','-map',`0:${streamIndex}`,'-an','-sn','-dn','-frames:v','1','-fps_mode','passthrough',
    '-vf',`trim=end_pts=${pts+1},select=eq(pts\\,${pts}),scale=w='max(2,trunc(${height}*dar/2)*2)':h=${height}:flags=bilinear,setsar=1`,'-c:v','mjpeg','-q:v','5','-f','image2','-update','1',output];
}
/** .harness/cache/frames/<版>/<指紋>/s<ストリーム>[/h<高さ>]。各段で通常のフォルダーであることを確かめる。 */
export async function frameCacheFolder(directory:string,asset:SequenceAsset,streamIndex:number,height?:number):Promise<string>{
  if(!/^[a-f0-9]{64}$/.test(asset.fingerprint))throw new Error('素材の指紋が不正です');
  let folder=await cacheDirectory(directory,'frames');
  for(const segment of [FRAME_CACHE_VERSION,asset.fingerprint,`s${streamIndex}`,...(height===undefined?[]:[`h${height}`])]){
    folder=join(folder,segment);await mkdir(folder,{recursive:true});
    const info=await lstat(folder);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('コマ絵キャッシュの保存先が不正です');
  }
  return folder;
}
/** 書き出しの復号器と同じ読み方（ByteSource）で、検証済みのファイルを位置指定で読む（ファイルの読み取り位置は動かさない）。 */
function fileBytes(handle:FileHandle,size:number,signal:AbortSignal):ByteSource{
  return {size,async read(start,end){
    signal.throwIfAborted();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>size)throw new Error('映像の読み込み範囲が不正です');
    const bytes=new Uint8Array(end-start);
    for(let done=0;done<bytes.length;){const {bytesRead}=await handle.read(bytes,done,bytes.length-done,start+done);if(!bytesRead)throw new Error('映像データが途中で切れています');done+=bytesRead;}
    return bytes.buffer;
  }};
}
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
/** 編集リストを無視した FFmpeg の時刻が MP4 の生の cts と一致するかを、復号順の先頭のこの数のパケットで確かめる。 */
const GUARD_PACKETS=8;
interface Mp4Layout {timeBase:{num:number;den:number};pts:number[];streamTimeBase:{num:number;den:number};decodePts:number[];decodeFrom:number[];leadingCts:number[]}
function unsupportedMp4(asset:SequenceAsset,error:unknown):undefined{
  console.warn('[sme] コマ絵の索引: 書き出しの復号器が開けない素材のため、FFmpeg の表示時刻で作ります:',asset.id,error instanceof Error?error.message:String(error));
  return undefined;
}
/** MP4 を書き出しの時刻表で並べる。書き出しの復号器が開けない素材（MP4 以外・分割・複雑な編集リスト等）は undefined（FFmpeg の表示時刻で作る）。 */
async function mp4Layout(handle:FileHandle,asset:SequenceAsset,streamIndex:number,signal:AbortSignal):Promise<Mp4Layout|undefined>{
  // 書き出しと同じ対応: 素材の映像ストリームの中での順番 → MP4 の映像トラックの順番（sceneRenderer）
  const position=asset.streams.filter(stream=>stream.kind==='video').findIndex(stream=>stream.index===streamIndex);
  let bytes:ByteSource,file:Awaited<ReturnType<typeof readMp4Movie>>['file'],track:Awaited<ReturnType<typeof readMp4Movie>>['movie']['videoTracks'][number]|undefined;
  let sampleInfo:ReturnType<typeof file.getTrackSamplesInfo>;
  try{
    bytes=await videoOnlyMp4Bytes(fileBytes(handle,(await handle.stat()).size,signal));
    const read=await readMp4Movie(bytes);file=read.file;track=read.movie.videoTracks[position];
    if(!track)throw new Error('映像トラックが見つかりません');
    sampleInfo=file.getTrackSamplesInfo(track.id);
  }catch(error){
    // mp4box で読む段の失敗は種類を問わず戻す（壊れた素材で mp4box が内部の TypeError 等を投げても、コマ絵は出す）。中止と OS の読み取りエラーは上へ
    if(signal.aborted||(error instanceof Error&&'syscall' in error))throw error;
    return unsupportedMp4(asset,error);
  }
  let timeline:ReturnType<typeof mp4SampleTimeline>;
  try{timeline=mp4SampleTimeline(sampleInfo,mp4EditTimeline(track),bytes.size);}
  catch(error){
    // 書き出しの時刻表が「開けない」と判断した素材（素の Error）だけ戻す。プログラムの誤りは上へ
    if(!(error instanceof Error)||error.constructor!==Error)throw error;
    return unsupportedMp4(asset,error);
  }
  const {samples,presentation}=timeline,den=track.timescale/gcd(track.timescale,track.movie_timescale)*track.movie_timescale;
  const units=(time:Rational)=>{const value=time.num*(den/time.den);if(den%time.den!==0||!Number.isSafeInteger(value))throw new RangeError('映像フレームの時刻を確認できません');return value;};
  const starts=decodeStarts(samples.map(({sample})=>({pts:sample.cts,from:Math.min(sample.cts,sample.dts),key:sample.is_sync})));
  return {timeBase:{num:1,den},pts:presentation.map(frame=>units(frame.pts)),streamTimeBase:{num:1,den:track.timescale},
    decodePts:presentation.map(frame=>samples[frame.sample]!.sample.cts),decodeFrom:presentation.map(frame=>starts[frame.sample]!),
    leadingCts:samples.slice(0,GUARD_PACKETS).map(({sample})=>sample.cts)};
}
const indexes=new Map<string,FramePresentation>(),builds=new SharedPreparations<FramePresentation>();
function rememberIndex(key:string,index:FramePresentation){indexes.delete(key);indexes.set(key,index);while(indexes.size>32)indexes.delete(indexes.keys().next().value!);}
const increasing=(list:unknown):list is number[]=>Array.isArray(list)&&list.length>0&&list.every((p,i)=>Number.isSafeInteger(p)&&(i===0||p>list[i-1]));
const positive=(time:{num:number;den:number}|undefined)=>Number.isSafeInteger(time?.num)&&time!.num>0&&Number.isSafeInteger(time!.den)&&time!.den>0;
function validIndex(value:unknown):value is FramePresentation{
  const v=value as FramePresentation;
  return !!v&&v.version===3&&positive(v.timeBase)&&positive(v.streamTimeBase)&&Number.isSafeInteger(v.startMicroseconds)&&typeof v.ignoreEditList==='boolean'
    &&increasing(v.pts)&&increasing(v.decodePts)&&v.decodePts.length===v.pts.length
    &&Array.isArray(v.decodeFrom)&&v.decodeFrom.length===v.pts.length&&v.decodeFrom.every(Number.isSafeInteger);
}
export async function framePresentationIndex(directory:string,asset:SequenceAsset,streamIndex:number,signal?:AbortSignal):Promise<FramePresentation>{
  if(!asset.streams.some(stream=>stream.index===streamIndex&&stream.kind==='video'))throw new Error('映像ストリームがありません');
  // 中身は素材の指紋とストリームだけで決まるので、記憶にあればフォルダーの確認（mkdir・lstat）もしない
  const key=`${asset.fingerprint}/s${streamIndex}`,hit=indexes.get(key);if(hit){rememberIndex(key,hit);return hit;}
  const file=join(await frameCacheFolder(directory,asset,streamIndex),'index.json');
  return builds.get(file,async(work,lane)=>{
    try{const saved:unknown=JSON.parse(await readFile(file,'utf8'));if(validIndex(saved)){rememberIndex(key,saved);return saved;}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    const probe=resolveFfprobeBin();if(!probe.ok)throw new Error(probe.message);
    // 読み取りごとに開き直す（FFprobe は fd の現在位置から読むので、前の子プロセスが動かした位置を引き継がない）
    const leased=async<T>(use:(lease:SequenceAssetLease)=>Promise<T>):Promise<T>=>{
      const lease=await openSequenceAsset(directory,asset,work);try{const value=await use(lease);await lease.verify();return value;}finally{await lease.close();}};
    const ffprobe=(args:string[],maxStdoutBytes?:number)=>leased(lease=>withFfmpegSlot(lane,work,()=>run(probe.bin,['-v','error','-fd','3',...args,'fd:'],work,lease.handle.fd,maxStdoutBytes)));
    let index:FramePresentation|undefined;
    const layout=await leased(lease=>mp4Layout(lease.handle,asset,streamIndex,work));
    if(layout){
      const lines=(await ffprobe(['-ignore_editlist','1','-select_streams',String(streamIndex),'-read_intervals',`%+#${GUARD_PACKETS}`,
        '-show_entries','stream=time_base:format=start_time:packet=pts','-of','csv=p=1'])).split('\n').map(line=>line.trim().split(','));
      const timeBase=lines.find(([section])=>section==='stream')?.[1],format=lines.find(([section])=>section==='format')?.[1];
      const packets=lines.filter(([section])=>section==='packet').map(([,pts])=>pts);
      // FFmpeg が編集リストを無視して読む時間単位と、復号順の先頭のパケットの時刻が MP4 の生の cts と一致する時だけ、その pts で選べる
      // （先頭のキーフレームの後に復号できない先行フレームが続く素材では、最小の cts と FFmpeg の開始時刻は一致しない）
      if(timeBase===`${layout.streamTimeBase.num}/${layout.streamTimeBase.den}`&&format&&format!=='N/A'
        &&packets.length===layout.leadingCts.length&&packets.every((pts,i)=>pts===String(layout.leadingCts[i]))){
        const {timeBase,pts,streamTimeBase,decodePts,decodeFrom}=layout;
        index={version:3,timeBase,pts,streamTimeBase,decodePts,decodeFrom,startMicroseconds:parseMicroseconds(format),ignoreEditList:true};
      }else console.warn('[sme] コマ絵の索引: 編集リストを無視した FFmpeg の時刻が MP4 と一致しないため、FFmpeg の表示時刻で作ります:',asset.id,lines.join(' '));
    }
    index??=parseFramePresentation(await ffprobe(['-select_streams',String(streamIndex),'-show_entries','stream=time_base:format=start_time:packet=pts,dts,flags','-of','csv=p=1'],FRAME_INDEX_MAX_OUTPUT));
    // コマの番号の意味は索引が決める。作り直した索引の番号付けは前と違いうるので、前の索引で保存したコマ（h<高さ>/<番号>.jpg）を消してから書く
    // （書いてから消すと、途中で止まった時に新しい索引と古い絵が残る）。
    const folder=dirname(file);for(const name of await readdir(folder))if(/^h\d+$/.test(name))await rm(join(folder,name),{recursive:true,force:true});
    const temporary=`${file}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,JSON.stringify(index),{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>undefined);}
    rememberIndex(key,index);return index;
  },signal,'filmstrip');
}
/** 試験用: プロセス内の索引の記憶を消す（ディスクの index.json は残す）。 */
export function forgetFramePresentations():void{indexes.clear();}
