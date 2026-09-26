import {chromiumDownloadPlatform} from './resolveChromium';
import {NATIVE_CHROME_VERSION} from './resolveNativeChromium';

/** Actual official archives, independently downloaded and CRC checked 2026-09-12. */
export const NATIVE_CHROME_ARCHIVES = {
  'mac-arm64': 'fbab7ac5c63f72771a7cd79ab15ed6f198b0f9567ec927c9cf5ece3b1f08ffb1',
  'mac-x64': '9d896b8c242652fe274b5ff7029853ac4b1471086ecfe48a675552783323108a',
  win64: '6cd8c5f6eeff7b6515dbcd35d050f696da3f7eac4b4a209c06e3d4354c2704a6',
} as const;
export function nativeChromeDistribution(platform: NodeJS.Platform, arch: string) {
  const name = chromiumDownloadPlatform(platform, arch);
  if (!name || !(name in NATIVE_CHROME_ARCHIVES)) throw new Error(`unsupported-platform: ${platform}/${arch}`);
  return {platform:name, version:NATIVE_CHROME_VERSION,
    sha256:NATIVE_CHROME_ARCHIVES[name as keyof typeof NATIVE_CHROME_ARCHIVES],
    url:`https://storage.googleapis.com/chrome-for-testing-public/${NATIVE_CHROME_VERSION}/${name}/chrome-${name}.zip`};
}
