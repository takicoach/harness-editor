import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {handleApi} from '../../plugin';
import {sendApiError} from '../../http';
import {createSequenceProject} from '../create';
/** テスト専用: 素材1本から新形式の案件を作り、本番と同じ handleApi を通す HTTP サーバを立てる。 */
export async function nativeApiProject(sourcePath:string):Promise<{root:string;id:string;directory:string;origin:string;close():Promise<void>}>{
  const root=await mkdtemp(join(tmpdir(),'harness-native-api-')),{id}=await createSequenceProject(root,{name:'case',videoName:basename(sourcePath),sourcePath});
  const server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>{sendApiError(res,error);});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {root,id,directory:join(root,id),origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}};
}
