import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect,it} from 'vitest';

// A separate real Node process must survive cancellation without a global
// uncaughtException handler. FileHandle streams differ from path streams here.
it.each(['already-aborted','during-open-stat','during-serve-verify','during-stream'])(
  'rejects managed asset cancellation (%s) without an unhandled stream error',async mode=>{
    const assets=pathToFileURL(resolve('src/server/sequence/assets.ts')).href;
    const serve=pathToFileURL(resolve('src/server/sequence/serveAsset.ts')).href;
    const source=`
      import assert from 'node:assert/strict';
      import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      import {createHash} from 'node:crypto';
      import {createServer} from 'node:http';
      import {setImmediate} from 'node:timers/promises';
      import {openSequenceAsset} from ${JSON.stringify(assets)};
      import {serveSequenceAsset} from ${JSON.stringify(serve)};
      const mode=${JSON.stringify(mode)},root=await mkdtemp(join(tmpdir(),'harness-managed-abort-'));
      const bytes=Buffer.alloc(2*1024*1024,37),path=join(root,'source.wav');await writeFile(path,bytes);
      const asset={file:'source.wav',name:'source.wav',fingerprint:createHash('sha256').update(bytes).digest('hex')};
      const controller=new AbortController();let server,prototype,originalStat,calls=0,caught;
      try{
        if(mode.startsWith('during-serve')||mode==='during-stream'){
          const warm=await openSequenceAsset(root,asset);await warm.close();
        }
        if(mode==='already-aborted')controller.abort();
        if(mode==='during-open-stat'||mode==='during-serve-verify'){
          const handle=await open(path,'r');prototype=Object.getPrototypeOf(handle);await handle.close();
          originalStat=prototype.stat;
          // Complete the real stat, then cancel at this asynchronous I/O boundary.
          // Warm serve: open before + open verify + response size + response verify.
          prototype.stat=async function(...args){const value=await originalStat.apply(this,args);
            if(++calls===(mode==='during-open-stat'?1:4))controller.abort();return value;};
        }
        if(mode==='already-aborted'||mode==='during-open-stat'){
          try{const lease=await openSequenceAsset(root,asset,controller.signal);await lease.close();}
          catch(error){caught=error.name;}
        }else{
          let finish;const finished=new Promise(resolve=>finish=resolve);
          server=createServer((req,res)=>{
            if(mode==='during-stream'){
              const write=res.write.bind(res);res.write=(...args)=>{const result=write(...args);controller.abort();return result;};
            }
            void serveSequenceAsset(res,root,asset,undefined,controller.signal)
              .catch(error=>{caught=error.name;if(error.name!=='AbortError')console.error(error.stack);res.destroy();}).finally(finish);
          });
          await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
          try{await (await fetch('http://127.0.0.1:'+server.address().port)).arrayBuffer();}catch{}
          await finished;
        }
        if(originalStat){prototype.stat=originalStat;originalStat=undefined;}
        await setImmediate();await setImmediate();
        assert.equal(controller.signal.aborted,true);assert.equal(caught,'AbortError');
        const retry=await openSequenceAsset(root,asset);
        try{assert.deepEqual(await retry.handle.readFile(),bytes);await retry.verify();}finally{await retry.close();}
        console.log(JSON.stringify({mode,caught,retry:true}));
      }finally{
        if(originalStat)prototype.stat=originalStat;
        if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        await rm(root,{recursive:true,force:true});
      }
    `;
    const child=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',source],{timeout:15000});
    expect(JSON.parse(child.stdout.trim())).toEqual({mode,caught:'AbortError',retry:true});
    expect(child.stderr).toBe('');
  },20000);
