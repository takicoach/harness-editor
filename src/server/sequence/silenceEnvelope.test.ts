import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSilenceEnvelope} from './silenceEnvelope';
import {rational} from '../../core/sequence/time';
it('measures right-only and anti-phase audio without cancellation across read chunks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'silence-rms-'));
  try{
    const samples=48000,buf=Buffer.alloc(samples*8);
    for(let i=0;i<samples;i++){const v=i<16000||i>=32000?.5:0;buf.writeFloatLE(i<16000?0:v,i*8);buf.writeFloatLE(-v,i*8+4);}
    const file=join(dir,'pcm');await writeFile(file,buf);
    const data=await readSilenceEnvelope({file,sampleCount:samples,sampleRate:48000,channels:2,rate:rational(1)},new AbortController().signal);
    expect(data.rms).toHaveLength(100);expect(data.rms[10]).toBe(.5);expect(data.rms[50]).toBe(0);expect(data.rms[90]).toBe(.5);
    const controller=new AbortController();controller.abort();await expect(readSilenceEnvelope({file,sampleCount:samples,sampleRate:48000,channels:2,rate:rational(1)},controller.signal)).rejects.toThrow();
  }finally{await rm(dir,{recursive:true,force:true});}
});
