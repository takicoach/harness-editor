import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {nativeChromeDistribution} from './nativeChromeDistribution';
import {NATIVE_CHROME_REVISION,NATIVE_CHROME_VERSION,nativeChromeToolsPath} from './resolveNativeChromium';
describe('native browser distribution wiring',()=>{
 it.each(['setup.command','setup.bat'])('%s installs full Chrome independently of the legacy shell',file=>{
  const source=readFileSync(file,'utf8');expect(source).toContain('scripts/native-chromium-setup.ts');expect(source).toContain('chromium-health.ts');expect(source).toContain('HE_SETUP_SKIP_CHROMIUM');
 });
 it('pins both native browser release and revision to installed Playwright Chromium',()=>{
  const browsers=JSON.parse(readFileSync(createRequire(import.meta.url).resolve('playwright-core/package.json').replace(/package\.json$/, 'browsers.json'),'utf8')).browsers;const full=browsers.find((x:{name:string})=>x.name==='chromium');
  expect(full.browserVersion).toBe(NATIVE_CHROME_VERSION);expect(full.revision).toBe(NATIVE_CHROME_REVISION);
 });
 it.each([['darwin','arm64','mac-arm64'],['darwin','x64','mac-x64'],['win32','x64','win64']] as const)('uses distinct full-browser archive and tools path for %s/%s',(platform,arch,folder)=>{
  const d=nativeChromeDistribution(platform,arch);expect(d.url).toBe(`https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.96/${folder}/chrome-${folder}.zip`);expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);expect(nativeChromeToolsPath('/editor',platform,arch)).toContain('chrome-for-testing');
 });
 it('refuses unsupported distribution without pretending developer Linux cache is installable',()=>expect(()=>nativeChromeDistribution('linux','x64')).toThrow('unsupported-platform'));
});

it('matches the recorded official archive measurements for all distribution platforms',()=>{
 const ledger=JSON.parse(readFileSync('src/server/native-chromium-sha-verified.json','utf8'));expect(ledger.version).toBe(NATIVE_CHROME_VERSION);expect(ledger.artifacts).toHaveLength(3);
 for(const a of ledger.artifacts){const d=nativeChromeDistribution(a.platform==='win64'?'win32':'darwin',a.platform==='mac-arm64'?'arm64':'x64');expect(d.sha256).toBe(a.sha256);expect(d.url).toBe(a.source);expect(a.zipCRC).toBe('pass');expect(a.executableVersion).toBe(NATIVE_CHROME_VERSION);expect(a.executableSha256).toMatch(/^[a-f0-9]{64}$/);expect(a.bytes).toBeGreaterThan(100000000);}
});
