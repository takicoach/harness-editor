import {createReadStream,createWriteStream,constants} from 'node:fs';
import {mkdir,mkdtemp,lstat,realpath,rename,rm,writeFile,copyFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform,Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeChromeDistribution} from './nativeChromeDistribution';
import {nativeChromeToolsPath,NATIVE_CHROME_VERSION} from './resolveNativeChromium';
import {checkNativeChromeHealth} from './nativeChromeHealth';
const exec=promisify(execFile), MAX_ARCHIVE_BYTES=1024*1024*1024;
export async function sha256File(path:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function downloadNativeChrome(url:string,file:string,fetcher:typeof fetch=fetch,externalSignal?:AbortSignal):Promise<void>{
  const timeout=AbortSignal.timeout(120_000),signal=externalSignal?AbortSignal.any([timeout,externalSignal]):timeout;let response:Response|undefined;
  signal.throwIfAborted();
  for(let redirects=0;redirects<=5;redirects++){
    if(new URL(url).protocol!=='https:')throw new Error('insecure-download-url');
    response=await fetcher(url,{redirect:'manual',signal});
    if([301,302,303,307,308].includes(response.status)){
      await response.body?.cancel();const location=response.headers.get('location');
      if(!location)throw new Error('missing-redirect-location');url=new URL(location,url).href;continue;
    }
    break;
  }
  if(!response?.ok||!response.body){await response?.body?.cancel();throw new Error(`download-failed: ${response?.status}`);}
  let bytes=0;
  await pipeline(Readable.fromWeb(response.body as never),new Transform({transform(chunk,_,done){bytes+=chunk.length;done(bytes>MAX_ARCHIVE_BYTES?new Error('archive-too-large'):null,chunk);}}),createWriteStream(file,{flags:'wx'}),{signal});
}
async function unpack(archive:string,directory:string,platform:NodeJS.Platform,signal?:AbortSignal):Promise<void>{
  if(platform==='win32'){
    await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:HARNESS_CHROME_ARCHIVE -DestinationPath $env:HARNESS_CHROME_UNPACK; Get-ChildItem -LiteralPath $env:HARNESS_CHROME_UNPACK -Recurse -File | Unblock-File"],{env:{...process.env,HARNESS_CHROME_ARCHIVE:archive,HARNESS_CHROME_UNPACK:directory},timeout:120_000,signal});
  }else await exec('/usr/bin/unzip',['-q',archive,'-d',directory],{timeout:120_000,signal});
}
export interface NativeChromeInstallOptions {
  editorRoot:string; platform?:NodeJS.Platform; arch?:string;
  /** A private/local copy is still checked against the production archive SHA. */
  archive?:string; signal?:AbortSignal;
}
/** Injectable effects are internal test dependencies; no CLI bypass for SHA/health. */
export interface NativeChromeInstallDeps {
  download:typeof downloadNativeChrome; unpack:typeof unpack; health:typeof checkNativeChromeHealth;
  rename:typeof rename; lstat:typeof lstat; digest:typeof sha256File;
}
const defaults:NativeChromeInstallDeps={download:downloadNativeChrome,unpack,health:checkNativeChromeHealth,rename,lstat,digest:sha256File};
async function directoryInside(parent:string,name:string):Promise<string>{
  const child=join(parent,name);await mkdir(child,{recursive:true});
  if((await lstat(child)).isSymbolicLink()||await realpath(child)!==child)throw new Error('unsafe-tools-directory');
  return child;
}
/** Stage -> verify -> promote; a failed candidate never replaces the existing install. */
export async function installNativeChrome(options:NativeChromeInstallOptions,effects:Partial<NativeChromeInstallDeps>={}):Promise<{bin:string;installed:boolean}>{
  options.signal?.throwIfAborted();
  const deps={...defaults,...effects},platform=options.platform??process.platform,arch=options.arch??process.arch;
  const distribution=nativeChromeDistribution(platform,arch),root=await realpath(options.editorRoot);
  const tools=await directoryInside(root,'tools'),base=await directoryInside(tools,'chrome-for-testing');
  const target=join(base,NATIVE_CHROME_VERSION),bin=nativeChromeToolsPath(root,platform,arch)!;
  const lock=join(base,'.install.lock');await mkdir(lock).catch(()=>{throw new Error('native-browser-install-busy: 別のsetupが実行中です');});
  let temporary:string|undefined,backup:string|undefined,promoted=false;
  try {
    try {await lstat(target).then(s=>{if(s.isSymbolicLink())throw new Error('unsafe-installed-directory');});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try {await deps.health(bin,options.signal);options.signal?.throwIfAborted();return {bin,installed:false};}catch{options.signal?.throwIfAborted();/* Stage a replacement without retiring the old copy yet. */}
    temporary=await mkdtemp(join(base,'.stage-'));const archive=join(temporary,'chrome.zip');
    if(options.archive)await copyFile(options.archive,archive,constants.COPYFILE_EXCL);
    else await deps.download(distribution.url,archive,undefined,options.signal);
    if(await deps.digest(archive)!==distribution.sha256)throw new Error('archive-sha256-mismatch');
    const extracted=join(temporary,'unpacked');await mkdir(extracted);options.signal?.throwIfAborted();await deps.unpack(archive,extracted,platform,options.signal);
    const suffix=relative(target,bin);if(isAbsolute(suffix)||suffix.startsWith('..'))throw new Error('unsafe-browser-path');
    const stagedBin=join(extracted,suffix);
    if(!(await lstat(stagedBin)).isFile())throw new Error('missing-browser-executable');
    await deps.health(stagedBin,options.signal);
    options.signal?.throwIfAborted();
    await writeFile(join(extracted,'harness-native-chrome.json'),JSON.stringify({...distribution,executableSha256:await sha256File(stagedBin)},null,2)+'\n');
    options.signal?.throwIfAborted();
    let hasPrevious=false;
    try {await deps.lstat(target);hasPrevious=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // lstat and receipt/hash work yield: cancellation must be checked immediately
    // before the first destructive rename, not just after staged browser health.
    options.signal?.throwIfAborted();
    if(hasPrevious){const previous=join(temporary,'previous');await deps.rename(target,previous);backup=previous;}
    try {
      // Retirement is reversible. An abort while it was in flight restores the
      // old copy; rollback itself must not be cancelled by the same signal.
      options.signal?.throwIfAborted();
      // Commit starts here: rename is atomic but not abortable. Once dispatched,
      // report its result even if a later abort arrives, and finish cleanup.
      await deps.rename(extracted,target);promoted=true;
    }catch(error){
      if(backup){
        try {await deps.rename(backup,target);backup=undefined;}
        catch(rollbackError){throw new AggregateError([error,rollbackError],`native-browser-rollback-failed: ${String(error)}; ${String(rollbackError)}`,{cause:error});}
      }
      throw error;
    }
    return {bin,installed:true};
  } finally {
    // If rollback itself failed, keep the last installation and report its location.
    if(temporary&&!backup)await rm(temporary,{recursive:true,force:true});
    else if(temporary&&backup){if(promoted)await rm(temporary,{recursive:true,force:true});else process.stderr.write(`previous-install-preserved: ${backup}\n`);}
    await rm(lock,{recursive:true,force:true});
  }
}
