import {decodePngRgba} from './pngRgba';
import {chromium} from 'playwright-core';
import {NATIVE_CHROME_VERSION} from './resolveNativeChromium';

/** Always checks the supplied executable, never a cached/override substitute. */
export async function checkNativeChromeHealth(bin: string, signal?:AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const server=await chromium.launchServer({executablePath:bin,headless:true,timeout:30_000});
  const cancel=()=>{void server.kill().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    signal?.throwIfAborted();
    await Promise.race([
      (async()=>{
        const browser=await chromium.connect(server.wsEndpoint(),{timeout:10_000});
        try {
          if(browser.version()!==NATIVE_CHROME_VERSION)throw new Error(`version-mismatch: ${browser.version()}`);
          const page=await browser.newPage({viewport:{width:2,height:2},deviceScaleFactor:1});
          page.setDefaultTimeout(10_000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
          await page.setContent('<body style="margin:0;background:rgb(23,91,177)"></body>');
          const png=await page.screenshot({type:'png',timeout:10_000});
          const pixels=decodePngRgba(png);
          if(pixels.width!==2||pixels.height!==2||pixels.data.some((v,i)=>v!==[23,91,177,255][i%4])||errors.length)throw new Error('render-health-failed');
        } finally {await browser.close();}
      })(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void server.kill().catch(()=>{});reject(new Error('native-browser-health-timeout'));},60_000);}),
    ]);
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    // Force the owned process down if graceful close itself stops responding.
    let closeTimer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([server.close(),new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>{void server.kill().catch(()=>{});reject(new Error('native-browser-close-timeout'));},5_000);})]);}
    finally {clearTimeout(closeTimer);if(server.process()?.exitCode===null)await server.kill();}
  }
}
