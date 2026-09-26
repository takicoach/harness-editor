import {statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,win32} from 'node:path';
import {CHROME_HEADLESS_SHELL_VERSION,CHROME_HEADLESS_SHELL_REVISION,chromiumDownloadPlatform,type ResolveChromiumDeps,type ResolveChromiumResult} from './resolveChromium';

// Both capture engines follow the same pinned Playwright / Chrome release.
// Native video decoding requires full Chrome: the shell can reject HEVC that
// full Chrome decodes on the same machine. Keep the legacy shell resolver intact.
export const NATIVE_CHROME_VERSION=CHROME_HEADLESS_SHELL_VERSION;
export const NATIVE_CHROME_REVISION=CHROME_HEADLESS_SHELL_REVISION;

function executableParts(platform:NodeJS.Platform,arch:string):string[]|null {
  if(platform==='darwin'&&(arch==='arm64'||arch==='x64'))return [`chrome-mac-${arch}`,'Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'];
  if(platform==='win32'&&arch==='x64')return ['chrome-win64','chrome.exe'];
  if(platform==='linux'&&arch==='x64')return ['chrome-linux64','chrome'];
  return null;
}
export function nativeChromeToolsPath(root:string,platform:NodeJS.Platform,arch:string):string|null {
  const parts=executableParts(platform,arch);
  if(!parts||!chromiumDownloadPlatform(platform,arch))return null;
  const path=platform==='win32'?win32: {join};
  return path.join(root,'tools','chrome-for-testing',NATIVE_CHROME_VERSION,...parts);
}
export function nativeChromeFromCachePath(file:string,platform:NodeJS.Platform,arch:string):string|null {
  const parts=executableParts(platform,arch);if(!parts)return null;
  const segments=file.split(/[\\/]/),index=segments.findIndex(p=>/^chromium(?:_headless_shell)?-\d+$/.test(p));
  if(index<=0)return null;
  return [...segments.slice(0,index),`chromium-${NATIVE_CHROME_REVISION}`,...parts].join(file.includes('\\')?'\\':'/');
}
function cachePath():string|null {
  try{return (createRequire(import.meta.url)('playwright-core') as {chromium:{executablePath():string}}).chromium.executablePath();}
  catch{return null;}
}
function existingFile(file:string):boolean {try{return statSync(file).isFile();}catch{return false;}}
export function resolveNativeChromiumBin(deps:Partial<ResolveChromiumDeps>={}):ResolveChromiumResult {
  const env=deps.env??process.env,platform=deps.platform??process.platform,arch=deps.arch??process.arch;
  const exists=deps.exists??existingFile,override=env.HARNESS_CHROMIUM?.trim();
  if(override)return exists(override)?{ok:true,bin:override,source:'env'}:{ok:false,kind:'env-path-missing',message:`環境変数 HARNESS_CHROMIUM に指定されたパスが見つかりません: ${override}`};
  const bundled=nativeChromeToolsPath(deps.editorRoot??process.cwd(),platform,arch);
  if(bundled&&exists(bundled))return {ok:true,bin:bundled,source:'tools'};
  const cache=(deps.defaultCachePath??cachePath)();
  const full=cache&&nativeChromeFromCachePath(cache,platform,arch);
  if(full&&exists(full))return {ok:true,bin:full,source:'playwright-cache'};
  return bundled?{ok:false,kind:'chromium-missing',message:'独自書き出し用ブラウザが見つかりません。setup をもう一度実行してください。'}:
    {ok:false,kind:'unsupported-platform',message:`未対応の OS/CPU 構成です（${platform}/${arch}）。独自書き出し用ブラウザを自動導入できません。`};
}
