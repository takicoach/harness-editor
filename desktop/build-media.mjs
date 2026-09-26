// Build redistributable static executables rather than using npm binaries built with --enable-nonfree.
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../dist/desktop/media/',import.meta.url));
const prefix=join(root,'installed');
await mkdir(root,{recursive:true});
function run(bin,args,cwd,env=process.env){const r=spawnSync(bin,args,{cwd,env,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${bin}: ${r.status}`);}
const sources=[
 {name:'x264',dir:'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55',file:'x264.tar.gz',url:'https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz',sha:'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9'},
 {name:'ffmpeg',dir:'ffmpeg-9.0.2',file:'ffmpeg.tar.xz',url:'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',sha:'8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'},
];
for(const source of sources){
 const file=join(root,source.file);
 if(!existsSync(file)){run('/usr/bin/curl',['-fL','--retry','2','--max-time','180','-o',file,source.url],root);}
 if(createHash('sha256').update(await readFile(file)).digest('hex')!==source.sha)throw new Error(`Checksum mismatch: ${source.name}`);
 if(!existsSync(join(root,source.dir)))run('/usr/bin/tar',['-xf',file,'-C',root],root);
}
const env={...process.env,MACOSX_DEPLOYMENT_TARGET:'12.0',PKG_CONFIG_PATH:join(prefix,'lib/pkgconfig')};
const x264Flags=[`--prefix=${prefix}`,'--enable-static','--disable-cli','--disable-opencl'];
const ffmpegFlags=[`--prefix=${prefix}`,'--disable-autodetect','--disable-shared','--enable-static','--disable-doc','--disable-debug','--disable-ffplay','--enable-gpl','--enable-libx264','--enable-videotoolbox','--enable-audiotoolbox','--enable-zlib','--pkg-config-flags=--static'];
if(!existsSync(join(prefix,'bin/ffmpeg'))){
 run('./configure',x264Flags,join(root,sources[0].dir),env);run('/usr/bin/make',['-j4'],join(root,sources[0].dir),env);run('/usr/bin/make',['install'],join(root,sources[0].dir),env);
 run('./configure',ffmpegFlags,join(root,sources[1].dir),env);run('/usr/bin/make',['-j4'],join(root,sources[1].dir),env);run('/usr/bin/make',['install'],join(root,sources[1].dir),env);
}
await writeFile(join(root,'BUILD.json'),JSON.stringify({sources,x264Flags,ffmpegFlags,macOSDeploymentTarget:'12.0'},null,2)+'\n');
const notices=join(root,'sources');await mkdir(notices,{recursive:true});
for(const source of sources)await cp(join(root,source.file),join(notices,source.file));
await cp(new URL('./build-media.mjs',import.meta.url),join(notices,'build-media.mjs'));
await cp(join(root,'BUILD.json'),join(notices,'BUILD.json'));
await cp(join(root,sources[0].dir,'COPYING'),join(notices,'X264-COPYING'));
await cp(join(root,sources[1].dir,'COPYING.GPLv2'),join(notices,'FFMPEG-COPYING.GPLv2'));
for(const tool of ['ffmpeg','ffprobe']){
 const bin=join(prefix,'bin',tool);
 const deps=spawnSync('/usr/bin/otool',['-L',bin],{encoding:'utf8'});if(deps.status!==0)throw new Error('otool failed');
 if(deps.stdout.split('\n').slice(1).some(line=>line.trim()&&!/^\s*\/(usr\/lib|System\/Library)\//.test(line)))throw new Error(`Non-system library: ${deps.stdout}`);
 run(bin,['-version'],root);
}
console.log(`Media executables ready: ${prefix}`);
