import {cp, mkdir, readFile, writeFile, chmod, mkdtemp, symlink, readdir, readlink, realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, relative, isAbsolute, resolve} from 'node:path';
import {packager} from '@electron/packager';
import {Resvg} from '../node_modules/@resvg/resvg-js/index.js';
import {stageTranscriptionScript} from './runtime-support.mjs';
const repo = fileURLToPath(new URL('..',import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('初版はApple Silicon Macでビルドしてください');
const appVersion = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;
const out = join(repo,'dist','desktop');await mkdir(out,{recursive:true});
const stage = await mkdtemp(join(out,'build-'));
const cache = join(out,'downloads');await mkdir(cache,{recursive:true});
function run(bin,args,cwd=repo,env=process.env) {
  const result=spawnSync(bin,args,{cwd,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${bin} exited ${result.status}`);
}
async function download(url,file,sha) {
  if(existsSync(file)&&createHash('sha256').update(await readFile(file)).digest('hex')===sha)return;
  console.log(`Download ${url}`);
  const response=await fetch(url);if(!response.ok)throw new Error(`${url}: ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(data).digest('hex')!==sha)throw new Error(`Checksum mismatch: ${url}`);
  await writeFile(file,data);
}
const nodeVersion='22.23.2';
const nodeArchive=join(cache,`node-v${nodeVersion}-darwin-arm64.tar.gz`);
await download(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-arm64.tar.gz`,nodeArchive,'61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6');
run('/usr/bin/tar',['-xzf',nodeArchive,'-C',stage]);
const nodeRoot=join(stage,`node-v${nodeVersion}-darwin-arm64`), node=join(nodeRoot,'bin','node');
const runtime=join(stage,'runtime');await mkdir(runtime,{recursive:true});
for(const entry of ['src','public','project-template','index.html','native-render.html','vite.config.ts','tsconfig.json','LICENSE']) {
  await cp(join(repo,entry),join(runtime,entry),{recursive:true,filter:source=>{
    const path=relative(repo,source);
    return !/(^|\/)(__fixtures__|node_modules)(\/|$)|\.(test|spec)\.[^/]+$/.test(path);
  }});
}
await stageTranscriptionScript(repo, runtime);
await mkdir(join(runtime,'desktop'),{recursive:true});await cp(join(repo,'desktop/server.mjs'),join(runtime,'desktop/server.mjs'));
await cp(join(repo,'desktop/runtime/package.json'),join(runtime,'package.json'));
await cp(join(repo,'desktop/runtime/package-lock.json'),join(runtime,'package-lock.json'));
const buildEnv={...process.env,PATH:`${join(nodeRoot,'bin')}:${process.env.PATH}`};
run(node,[join(nodeRoot,'lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--no-audit','--no-fund'],runtime,buildEnv);
await mkdir(join(runtime,'tools'),{recursive:true});
await cp(join(nodeRoot,'lib/node_modules/npm'),join(runtime,'lib/node_modules/npm'),{recursive:true});
await symlink('../lib/node_modules/npm/bin/npm-cli.js',join(runtime,'tools/npm'));
await symlink('../lib/node_modules/npm/bin/npx-cli.js',join(runtime,'tools/npx'));
await cp(node,join(runtime,'tools/node'));await cp(join(nodeRoot,'LICENSE'),join(runtime,'tools/NODE-LICENSE'));
const media=join(out,'media');
for(const name of ['ffmpeg','ffprobe']){
 const binary=join(media,'installed','bin',name);
 if(!existsSync(binary))throw new Error('先に node desktop/build-media.mjs を実行してください');
 await cp(binary,join(runtime,'tools',name));await chmod(join(runtime,'tools',name),0o755);
 run(join(runtime,'tools',name),['-version']);
}
await cp(join(media,'sources'),join(runtime,'tools/media-sources'),{recursive:true});
const chromeManifest=JSON.parse(await readFile(join(repo,'src/server/native-chromium-sha-verified.json'),'utf8'));
const chrome=chromeManifest.artifacts.find(item=>item.platform==='mac-arm64');
const chromeZip=join(cache,`${chromeManifest.version}-${chrome.file}`);
await download(chrome.source,chromeZip,chrome.sha256);
const chromeDir=join(runtime,'tools','chrome-for-testing',chromeManifest.version);await mkdir(chromeDir,{recursive:true});
run('/usr/bin/ditto',['-x','-k',chromeZip,chromeDir]);
const appDir=join(stage,'app');await mkdir(appDir,{recursive:true});
await writeFile(join(appDir,'package.json'),JSON.stringify({name:'harness-editor-desktop',productName:'Harness Editor',version:appVersion,private:true,main:'main.cjs'}));
for(const file of ['main.cjs','policy.cjs','preload.cjs'])await cp(join(repo,'desktop',file),join(appDir,file));
await cp(join(repo,'desktop/THIRD-PARTY.md'),join(runtime,'THIRD-PARTY.md'));
const iconset=join(stage,'Harness.iconset');await mkdir(iconset);
const svg=await readFile(join(repo,'public/favicon.svg'),'utf8');
for(const size of [16,32,128,256,512])for(const scale of [1,2]){
 await writeFile(join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`),new Resvg(svg,{fitTo:{mode:'width',value:size*scale}}).render().asPng());
}
const icon=join(stage,'Harness.icns');run('/usr/bin/iconutil',['-c','icns','-o',icon,iconset]);
const apps=await packager({icon,dir:appDir,out:stage,name:'Harness Editor',appBundleId:'jp.takicoach.harness-editor',appVersion,platform:'darwin',arch:'arm64',electronVersion:'44.4.3',asar:false,prune:false,overwrite:false});
const appPath=join(apps[0],'Harness Editor.app');
// packager's extraResource copy rewrites relative links to absolute staging paths.
// Preserve relative links for Chrome frameworks, npm and command-line shims.
await cp(runtime,join(appPath,'Contents/Resources/runtime'),{recursive:true,verbatimSymlinks:true});
async function auditLinks(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const file=join(directory,entry.name);
  if(entry.isSymbolicLink()){
   const target=await readlink(file),resolved=await realpath(file);
   if(isAbsolute(target)||!resolved.startsWith(resolve(appPath)+'/'))throw new Error(`Non-portable link: ${file} -> ${target}`);
  }else if(entry.isDirectory())await auditLinks(file);
 }
}
await auditLinks(appPath);
// Internal test build only. Distribution signing/notarization is a separate release step.
run('/usr/bin/codesign',['--force','--deep','--sign','-',appPath]);
run('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
const zip=join(out,`Harness-Editor-${appVersion}-mac-arm64-preview.zip`);
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',appPath,zip]);
const result={appPath,zip,appVersion,nodeVersion,electronVersion:'44.4.3',architecture:'arm64',distribution:'preview-ad-hoc-signed',builtAt:new Date().toISOString()};
await writeFile(join(out,'latest.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
