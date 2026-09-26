import type {ByteSource} from './mp4FrameSource';

interface Box {start:number;end:number;body:number;type:string}
const MAX_METADATA_BYTES=32*1024*1024;
const invalid=()=>new Error('MP4の索引構造が不正です。編集用プロキシを作成してください');

/** Hide unused tracks before MP4Box expands per-sample tables. Byte offsets,
 * movie/video metadata and compressed video are unchanged; audio uses its own
 * decoder. A tiny constant-size PCM table can describe millions of samples. */
export async function videoOnlyMp4Bytes(source:ByteSource):Promise<ByteSource> {
  if(!Number.isSafeInteger(source.size)||source.size<8)throw invalid();
  const parse=(data:ArrayBuffer,at:number,limit:number,base=0):Box=>{
    if(data.byteLength<8)throw invalid();
    const view=new DataView(data),type=String.fromCharCode(...new Uint8Array(data,4,4));
    let size=view.getUint32(0),header=8;
    if(size===1){
      if(data.byteLength<16)throw invalid();
      const wide=view.getBigUint64(8);if(wide>BigInt(Number.MAX_SAFE_INTEGER))throw invalid();size=Number(wide);header=16;
    }else if(size===0)size=limit-at;
    if(size<header||!Number.isSafeInteger(at+size)||at+size>limit)throw invalid();
    return {start:base+at,end:base+at+size,body:base+at+header,type};
  };
  let moov:Box|undefined,top=0;
  for(let at=0;at<source.size;){
    if(++top>65536||source.size-at<8)throw invalid();
    const box=parse(await source.read(at,Math.min(at+16,source.size)),at,source.size);
    if(box.type==='moov'){if(moov)throw invalid();moov=box;}
    at=box.end;
  }
  if(!moov)throw new Error('MP4の索引を読み取れません: moovがありません');
  if(moov.end-moov.start>MAX_METADATA_BYTES)throw new Error('映像の索引が大きすぎます。編集用プロキシを作成してください');
  const metadata=await source.read(moov.start,moov.end),masks:number[]=[];
  const children=(parent:Box):Box[]=>{
    const result:Box[]=[];
    for(let at=parent.body;at<parent.end;){
      if(parent.end-at<8||result.length>=65536)throw invalid();
      const offset=at-moov!.start,box=parse(metadata.slice(offset,Math.min(offset+16,metadata.byteLength)),at,parent.end);
      result.push(box);at=box.end;
    }
    return result;
  };
  const movie=children(moov);
  if(movie.some(box=>box.type==='mvex'))throw new Error('分割MP4は編集用プロキシへ変換してください');
  for(const track of movie.filter(box=>box.type==='trak')){
    const media=children(track).filter(box=>box.type==='mdia');if(media.length!==1)throw invalid();
    const handlers=children(media[0]!).filter(box=>box.type==='hdlr');if(handlers.length!==1)throw invalid();
    const handler=handlers[0]!;if(handler.end-handler.body<12)throw invalid();
    const kind=String.fromCharCode(...new Uint8Array(metadata,handler.body-moov.start+8,4));
    if(kind!=='vide')masks.push(track.start+4);
  }
  if(!masks.length)return source;
  return {size:source.size,async read(start,end,signal){
    const original=await source.read(start,end,signal);
    const intersect=masks.filter(offset=>offset<end&&offset+4>start);
    if(!intersect.length)return original;
    // Never mutate a byte source's reusable cached buffer.
    const copy=original.slice(0),view=new Uint8Array(copy);
    for(const offset of intersect)for(let i=0;i<4;i++)if(offset+i>=start&&offset+i<end)view[offset+i-start]='free'.charCodeAt(i);
    return copy;
  }};
}
