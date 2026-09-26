import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rename,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerSequenceReference,reconnectSequenceReference} from './references';
import {preflightSequenceExport} from './exportPreflight';
import type {SequenceDocument} from '../../core/sequence/model';
const owned:string[]=[];
afterEach(async()=>{for(const dir of owned.splice(0))await rm(dir,{recursive:true,force:true});});
function wav(sample:number){const b=Buffer.alloc(1644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(sample,i);return b;}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'export-preflight-'));owned.push(root);const project=join(root,'project');await mkdir(project);
 const first=join(root,'first.wav'),second=join(root,'second.wav');await writeFile(first,wav(1));await writeFile(second,wav(2));
 const assets=[await registerSequenceReference(project,first,'撮影音声.wav'),await registerSequenceReference(project,second,'効果音.wav')];
 const document:SequenceDocument={schemaVersion:2,id:'p',name:'p',revision:0,fps:{num:30,den:1},resolution:{width:32,height:32},sequenceEndFrame:1,background:'#000',assets,tracks:[],clips:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};
 return {root,project,first,second,document};
}
it('accepts stable reference files without changing their links or document',async()=>{
 const f=await fixture(),before=JSON.stringify(f.document),metadata=await readFile(join(f.project,f.document.assets[0]!.file+'.json'));
 expect(await preflightSequenceExport(f.project,f.document)).toEqual({checked:2,referenceCount:2,issues:[]});
 expect(JSON.stringify(f.document)).toBe(before);expect(await readFile(join(f.project,f.document.assets[0]!.file+'.json'))).toEqual(metadata);
});
it('reports all missing or modified sources by name and accepts an explicit relink after repair',async()=>{
 const f=await fixture();await rename(f.first,f.first+'.moved');await writeFile(f.second,wav(3));
 const result=await preflightSequenceExport(f.project,f.document);
 expect(result.issues.map(i=>i.name)).toEqual(['撮影音声.wav','効果音.wav']);expect(result.issues[0]!.message).toContain('見つかりません');expect(result.issues[1]!.message).toMatch(/変更|一致/);
 expect(JSON.stringify(result)).not.toContain(f.root);
 await reconnectSequenceReference(f.project,f.document.assets[0]!,f.first+'.moved');await writeFile(f.second,wav(2));
 expect((await preflightSequenceExport(f.project,f.document)).issues).toEqual([]);
});
it('propagates cancellation instead of reporting a successful check',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();await expect(preflightSequenceExport(f.project,f.document,controller.signal)).rejects.toThrow();
});
