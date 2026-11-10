import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {nativeChromeDistribution} from './nativeChromeDistribution';
import {NATIVE_CHROME_REVISION,nativeChromeToolsPath,nativeChromeVersion} from './resolveNativeChromium';
describe('native browser distribution wiring',()=>{
 it.each(['setup.command','setup.bat'])('%s installs full Chrome independently of the legacy shell',file=>{
  const source=readFileSync(file,'utf8');expect(source).toContain('scripts/native-chromium-setup.ts');expect(source).toContain('chromium-health.ts');expect(source).toContain('HE_SETUP_SKIP_CHROMIUM');
 });
 it('pins every platform except Mac arm64 to the release and revision of installed Playwright Chromium',()=>{
  const browsers=JSON.parse(readFileSync(createRequire(import.meta.url).resolve('playwright-core/package.json').replace(/package\.json$/, 'browsers.json'),'utf8')).browsers;const full=browsers.find((x:{name:string})=>x.name==='chromium');
  for(const [platform,arch] of [['darwin','x64'],['win32','x64'],['linux','x64']] as const)expect(nativeChromeVersion(platform,arch)).toBe(full.browserVersion);
  expect(nativeChromeVersion('darwin','arm64')).not.toBe(full.browserVersion);expect(full.revision).toBe(NATIVE_CHROME_REVISION);
 });
 it.each([['darwin','arm64','mac-arm64','157.0.8103.38'],['darwin','x64','mac-x64','148.0.7778.96'],['win32','x64','win64','148.0.7778.96']] as const)('uses distinct full-browser archive and tools path for %s/%s',(platform,arch,folder,version)=>{
  const d=nativeChromeDistribution(platform,arch);expect(d.version).toBe(version);expect(d.url).toBe(`https://storage.googleapis.com/chrome-for-testing-public/${version}/${folder}/chrome-${folder}.zip`);expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(nativeChromeVersion(platform,arch)).toBe(version);expect(nativeChromeToolsPath('/editor',platform,arch)).toContain(`chrome-for-testing${platform==='win32'?'\\':'/'}${version}`);
 });
 it('refuses unsupported distribution without pretending developer Linux cache is installable',()=>expect(()=>nativeChromeDistribution('linux','x64')).toThrow('unsupported-platform'));
});

it('matches the recorded official archive measurements for all distribution platforms',()=>{
 const ledger=JSON.parse(readFileSync('src/server/native-chromium-sha-verified.json','utf8'));expect(ledger).not.toHaveProperty('version');expect(ledger.artifacts).toHaveLength(3);
 for(const a of ledger.artifacts){const d=nativeChromeDistribution(a.platform==='win64'?'win32':'darwin',a.platform==='mac-arm64'?'arm64':'x64');expect(d).toEqual({platform:a.platform,version:a.version,sha256:a.sha256,url:a.source});expect(a.zipCRC).toBe('pass');expect(a.executableVersion).toBe(a.version);expect(a.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);expect(a.executableSha256).toMatch(/^[a-f0-9]{64}$/);expect(a.bytes).toBeGreaterThan(100000000);}
});

it('packs the desktop app from the same Mac arm64 ledger entry that setup installs',()=>{
 const source=readFileSync('desktop/build.mjs','utf8'),ledger=JSON.parse(readFileSync('src/server/native-chromium-sha-verified.json','utf8'));
 expect(source).toContain("chromeManifest.artifacts.find(item=>item.platform==='mac-arm64')");
 expect(source).toContain("join(runtime,'tools','chrome-for-testing',chrome.version)");expect(source).toContain('download(chrome.source,chromeZip,chrome.sha256)');expect(source).not.toContain('chromeManifest.version');
 const packed=ledger.artifacts.find((a:{platform:string})=>a.platform==='mac-arm64'),d=nativeChromeDistribution('darwin','arm64');
 expect({version:packed.version,url:packed.source,sha256:packed.sha256}).toEqual({version:d.version,url:d.url,sha256:d.sha256});
 expect(nativeChromeToolsPath('/editor','darwin','arm64')).toBe(['/editor/tools/chrome-for-testing',packed.version,packed.executable].join('/'));
 // The notice packed beside it names the Chrome it ships.
 expect(source).toContain("cp(join(repo,'desktop/THIRD-PARTY.md'),join(runtime,'THIRD-PARTY.md'))");
 expect(readFileSync('desktop/THIRD-PARTY.md','utf8')).toContain(`Chrome for Testing ${packed.version} `);
});
