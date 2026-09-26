# Desktop preview — third-party components

The preview includes Electron 44.4.3 (Chromium/Node.js notices in the Electron distribution), Node.js 22.23.2 (tools/NODE-LICENSE), Chrome for Testing 148.0.7778.96 (its bundled notices), and exact npm dependencies in package-lock.json. Each npm package retains its license/notice files in node_modules. The editor's LICENSE remains in the runtime directory.

FFmpeg 9.0.2 and x264 revision b35605ace3ddf7c1a5d67a2eb553f034aef41d55 are built locally from pinned upstream source archives. The executables use GPL code, without --enable-nonfree. Corresponding sources, licenses, exact configure options and build script are included in tools/media-sources. These are separate subprocesses, not native libraries linked into the editor. The build checks for dependencies outside macOS system libraries and fails if any remain. See BUILD.json for source URLs/checksums. Public distribution still requires the normal release review of bundled components, fonts and presets.

Remotion and Hyperframes are NOT bundled in this first preview. The frame runtime is the editor's own runtime. The desktop shell does not change the editor license. Brain product presets in the private product checkout must not be published into the OSS repository merely because the desktop shell can also be built there.
