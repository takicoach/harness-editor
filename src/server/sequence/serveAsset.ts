import type {ServerResponse} from 'node:http';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {SequenceAsset} from '../../core/sequence/model';
import {contentTypeFor} from '../serveAsset';
import {parseRange} from '../serveVideo';
import {openSequenceAsset} from './assets';

/** Read ranges from the verified open file, including registered external media.
 * Retain one final chunk until the lease is rechecked: a changed or disconnected
 * source must not complete an HTTP response advertised as the saved asset. */
export async function serveSequenceAsset(res:ServerResponse,projectDirectory:string,asset:SequenceAsset,rangeHeader?:string,signal?:AbortSignal):Promise<void>{
  const lease=await openSequenceAsset(projectDirectory,asset,signal);
  try{
    const size=(await lease.handle.stat()).size,range=parseRange(rangeHeader,size);
    await lease.verify();
    signal?.throwIfAborted();
    const source=lease.handle.createReadStream({start:range?.start??0,...(range?{end:range.end}:{}),autoClose:false,signal});
    let held:Buffer|undefined;
    const guard=new Transform({
      transform(chunk:Buffer,_encoding,callback){if(held)this.push(held);held=chunk;callback();},
      flush(callback){void lease.verify().then(()=>{if(held)this.push(held);held=undefined;callback();},error=>callback(error));},
    });
    res.writeHead(range?206:200,{
      'Content-Type':contentTypeFor(asset.file),'Accept-Ranges':'bytes','Cache-Control':'no-store',
      'Content-Length':String(range?range.end-range.start+1:size),
      ...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${size}`} : {}),
    });
    await pipeline(source,guard,res,{signal});
  }finally{await lease.close();}
}
