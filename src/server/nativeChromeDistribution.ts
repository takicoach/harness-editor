import {createRequire} from 'node:module';
import {chromiumDownloadPlatform} from './resolveChromium';

export interface NativeChromeDistribution {platform:string; version:string; sha256:string; url:string}
interface VerifiedArchive {platform:string; version:string; sha256:string; source:string}

// The verified ledger is the only place a native Chrome release, archive URL and hash are written.
// Each archive carries its own release because Mac arm64 runs ahead of Playwright's pinned browser
// (HTML in Canvas needs 157); desktop/build.mjs packs the app from the same entry setup installs.
const archives=(createRequire(import.meta.url)('./native-chromium-sha-verified.json') as {artifacts:VerifiedArchive[]}).artifacts;

/** null where no official archive is verified (the Linux development cache, unsupported CPUs). */
export function findNativeChromeDistribution(platform:NodeJS.Platform,arch:string):NativeChromeDistribution|null {
  const name=chromiumDownloadPlatform(platform,arch),archive=name?archives.find(a=>a.platform===name):undefined;
  return archive?{platform:archive.platform,version:archive.version,sha256:archive.sha256,url:archive.source}:null;
}
export function nativeChromeDistribution(platform:NodeJS.Platform,arch:string):NativeChromeDistribution {
  const distribution=findNativeChromeDistribution(platform,arch);
  if(!distribution)throw new Error(`unsupported-platform: ${platform}/${arch}`);
  return distribution;
}
