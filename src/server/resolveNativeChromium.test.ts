import {describe,it,expect} from 'vitest';
import {nativeChromeToolsPath,nativeChromeFromCachePath,resolveNativeChromiumBin,NATIVE_CHROME_REVISION} from './resolveNativeChromium';
import type {ResolveChromiumDeps} from './resolveChromium';

const cache='/cache/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const base:ResolveChromiumDeps={env:{},platform:'darwin',arch:'arm64',editorRoot:'/editor',exists:()=>false,defaultCachePath:()=>cache};
describe('native capture uses full Chrome for video decoding',()=>{
  it('chooses an explicitly supplied existing binary and does not hide a missing override',()=>{
    expect(resolveNativeChromiumBin({...base,env:{HARNESS_CHROMIUM:' /custom/chrome '},exists:p=>p==='/custom/chrome'})).toEqual({ok:true,bin:'/custom/chrome',source:'env'});
    expect(resolveNativeChromiumBin({...base,env:{HARNESS_CHROMIUM:'/missing'},exists:p=>p!== '/missing'})).toMatchObject({ok:false,kind:'env-path-missing'});
  });
  it('prefers the bundled full browser over the development cache',()=>{
    expect(resolveNativeChromiumBin({...base,exists:()=>true})).toEqual({ok:true,bin:nativeChromeToolsPath('/editor','darwin','arm64'),source:'tools'});
  });
  it('never silently selects the installed legacy shell when full Chrome is absent',()=>{
    const seen:string[]=[];
    expect(resolveNativeChromiumBin({...base,exists:p=>{seen.push(p);return p.includes('headless-shell');}})).toMatchObject({ok:false,kind:'chromium-missing'});
    expect(seen.some(p=>p.includes('headless-shell'))).toBe(false);
  });
  it('selects full Chrome from the pinned development cache',()=>{
    expect(resolveNativeChromiumBin({...base,exists:p=>p===cache})).toEqual({ok:true,bin:cache,source:'playwright-cache'});
    expect(nativeChromeFromCachePath('/cache/chromium-1000/old-bin','darwin','arm64')).toBe(cache);
  });
  it('uses the Windows executable and supports spaces in the installation root',()=>{
    const path=nativeChromeToolsPath('C:\\My Editor','win32','x64');
    expect(path).toBe('C:\\My Editor\\tools\\chrome-for-testing\\148.0.7778.96\\chrome-win64\\chrome.exe');
    expect(nativeChromeFromCachePath('C:\\Cache\\chromium-1\\old','win32','x64')).toBe(`C:\\Cache\\chromium-${NATIVE_CHROME_REVISION}\\chrome-win64\\chrome.exe`);
  });
  it('allows a known Linux development cache without advertising a bundled Linux installer',()=>{
    const path=`/cache/chromium-${NATIVE_CHROME_REVISION}/chrome-linux64/chrome`;
    expect(nativeChromeToolsPath('/editor','linux','x64')).toBeNull();
    expect(resolveNativeChromiumBin({...base,platform:'linux',arch:'x64',exists:p=>p===path})).toEqual({ok:true,bin:path,source:'playwright-cache'});
    expect(resolveNativeChromiumBin({...base,platform:'linux',arch:'arm64'})).toMatchObject({ok:false,kind:'unsupported-platform'});
  });
  it('rejects cache paths without a recognized browser directory',()=>{
    expect(nativeChromeFromCachePath('/unrelated/chrome','darwin','arm64')).toBeNull();
    expect(resolveNativeChromiumBin({...base,defaultCachePath:()=>null})).toMatchObject({ok:false,kind:'chromium-missing'});
  });
});
