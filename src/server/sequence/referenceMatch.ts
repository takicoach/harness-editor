import {createHash} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {basename,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import {BROWSE_MEDIA_EXTENSIONS,type BrowseRoot} from '../browsePaths';
import {findSizeMatches,type FindOptions} from '../matchVideoSource';
import {isContained} from '../projectRoot';
import {HttpError} from '../http';

export const referenceMatchSchema=z.object({name:z.string().min(1).max(255).refine(name=>!name.startsWith('.')&&!/[\\/\0]/.test(name)),
 sizeBytes:z.number().int().positive().safe(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ReferenceMatchResult={matched:true;path:string;fingerprint:string}|{matched:false;reason:'no-candidate'|'search-truncated'|'ambiguous'|'content-mismatch'|'unreadable'};
const identity=(s:Stats)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');

/** Search metadata first; hash only a unique candidate through a bounded, fixed FD. Never falls back to copying. */
export async function matchSequenceReference(input:unknown,roots:BrowseRoot[],projectRoot:string,signal?:AbortSignal,
 options:Pick<FindOptions,'limits'|'now'>={}):Promise<ReferenceMatchResult>{
 const parsed=referenceMatchSchema.safeParse(input);if(!parsed.success)throw new HttpError(400,'素材照合の名前・サイズ・全体SHA-256が不正です');
 const request=parsed.data;signal?.throwIfAborted();
 const excluded=await realpath(projectRoot).catch(()=>resolve(projectRoot)),allowed:BrowseRoot[]=[];
 for(const root of roots){signal?.throwIfAborted();try{const path=await realpath(root.path);if(!isContained(path,excluded))allowed.push({...root,path});}catch{/* disconnected roots cannot yield a candidate */}}
 const found=findSizeMatches(allowed,request,{...options,exclude:[excluded],extensions:BROWSE_MEDIA_EXTENSIONS,strictPaths:true,signal});
 signal?.throwIfAborted();
 if(found.exhausted)return {matched:false,reason:'search-truncated'};
 if(found.candidates.length>1)return {matched:false,reason:'ambiguous'};
 const candidate=found.candidates[0];if(!candidate)return {matched:false,reason:'no-candidate'};
 const path=resolve(candidate.path),root=allowed.find(r=>isContained(path,r.path));
 const checkPath=async()=>{
  if(!root||isContained(path,excluded)||basename(path)!==request.name)throw new Error('source outside roots');
  let current=root.path;
  if(await realpath(current)!==current||(await lstat(current)).isSymbolicLink())throw new Error('root changed');
  for(const part of relative(root.path,path).split(sep)){current=resolve(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('source symlink');}
  if(await realpath(path)!==path)throw new Error('source moved');
 };
 try{
  await checkPath();signal?.throwIfAborted();
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await handle.stat();if(!before.isFile()||before.size!==request.sizeBytes)return {matched:false,reason:'content-mismatch'};
   const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
   while(position<before.size){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)throw new Error('source truncated');digest.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
   await checkPath();signal?.throwIfAborted();
   if(identity(before)!==identity(await handle.stat())||identity(before)!==identity(await lstat(path)))return {matched:false,reason:'content-mismatch'};
   if(digest.digest('hex')!==request.fingerprint)return {matched:false,reason:'content-mismatch'};
   return {matched:true,path,fingerprint:request.fingerprint};
  }finally{await handle.close();}
 }catch{signal?.throwIfAborted();return {matched:false,reason:'unreadable'};}
}
