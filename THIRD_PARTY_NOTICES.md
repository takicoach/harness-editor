# Third-Party Notices

The third-party software this project uses is listed below. Each entry states how it
is used, and reproduces its license where required. Packages installed from npm are
additionally enumerated, with their own license metadata, in `package.json` and
`package-lock.json`.

## OpenCut (MIT License)

The audio-waveform bucketing approach in `src/core/waveform.ts` (RMS / peak
reduction per render column) is a standard DSP technique and was informed by
OpenCut (https://github.com/OpenCut-app/OpenCut). No OpenCut source code is
copied into this repository; the implementation here is original.

## node-pty (MIT License)

`node-pty` (https://github.com/microsoft/node-pty) spawns the embedded
`claude` terminal session as a pseudo-terminal for the editor's AI panel.
Used as-is via npm; no source is bundled here.

## ws (MIT License)

`ws` (https://github.com/websockets/ws) provides the WebSocket transport
between the embedded terminal client and the server-side pty session. Used
as-is via npm; no source is bundled here.

## xterm.js (MIT License)

`@xterm/xterm` and `@xterm/addon-fit` (https://github.com/xtermjs/xterm.js)
render the embedded AI terminal in `src/app/panels/AiTerminal.tsx`.
Used as-is via npm; no source is bundled here.

---

OpenCut is distributed under the MIT License:

```
MIT License

Copyright (c) 2025 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Remotion

本エディタが扱う動画プロジェクトは Remotion（https://www.remotion.dev/）を使用します。
Remotion は MIT ではなく独自ライセンス（Remotion License）で提供されています。
個人および従業員3名までの組織は無料で利用できますが、4名以上の組織では
別途カンパニーライセンスが必要になる場合があります。
詳細: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
