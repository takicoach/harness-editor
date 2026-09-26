# Third-Party Notices

This project uses the dependencies and design references listed below.
Dependency license notices must be retained when distributing bundled builds.

## mammoth 1.12.3 (BSD-2-Clause)

`mammoth` (https://github.com/mwilliamson/mammoth.js) extracts text from uploaded
Word .docx scripts locally in the browser. Used without modification through
npm; browser bundles retain the package's license notice.

Copyright (c) 2013, Michael Williamson. All rights reserved.
The full notice follows.

```text
Copyright (c) 2013, Michael Williamson
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met: 

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer. 
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution. 

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## pdfjs-dist 5.6.205 (Apache-2.0)

`pdfjs-dist` (https://github.com/mozilla/pdf.js) extracts text from uploaded PDF
scripts locally using its browser worker. Used without modification through
npm. The Apache-2.0 license text is reproduced at the end of this section.
The importer does not configure optional CMap, standard-font, ICC, or
image-decoding WASM asset distributions. Text that cannot be extracted is
reported to the user for conversion to a supported text document.

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

## @noble/hashes 2.4.0 (MIT License)

`@noble/hashes` (https://github.com/paulmillr/noble-hashes) provides the hashing
implementation used by this project. The following notice is retained from
the installed package's `LICENSE` file.

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## MP4Box.js 2.4.1 (BSD-3-Clause)

`mp4box` (https://github.com/gpac/mp4box.js) reads MP4 sample indexes and codec
configuration for the native WebCodecs frame source. Used through npm without
modification; it is included in browser bundles that use that frame source.

Copyright (c) 2012. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of the copyright holder nor the
  names of its contributors may be used to endorse or promote products
  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

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

## @resvg/resvg-js (MPL-2.0 License)

`@resvg/resvg-js` (https://github.com/yisibl/resvg-js) rasterizes 図形注釈
（矢印・線・枠・楕円）の SVG を書き出し用 PNG に変換する（`src/server/shapeRaster.ts`）。
Used as-is via npm; no source is bundled here or modified.

## playwright-core (Apache-2.0 License)

`playwright-core` (https://github.com/microsoft/playwright) drives the headless
撮影エンジン（chrome-headless-shell）起動を `src/server/captureDriver.ts` /
`src/server/resolveChromium.ts` から行う（ネイティブ書き出しのオーバーレイ撮影）。
Used as-is via npm; no source is bundled here or modified. The Chromium binary
itself（Chrome for Testing headless shell）は本リポジトリには含まれず、setup 時に
利用者環境へダウンロードされる（次節）。

## setup が利用者環境へダウンロードする実行ファイル（本リポジトリでは再配布しない）

以下の 2 つは**本リポジトリにも配布 ZIP にも含まれていない**。`setup.command` /
`setup.bat` が、版と SHA-256 を固定したうえで利用者の PC へダウンロードし、
`tools/` 配下（`.gitignore` 済み）に配置する。したがって本プロジェクトによる
再配布（redistribution）は発生しない。

### Chrome for Testing headless shell (BSD-3-Clause)

`chrome-headless-shell`（Chromium ベース・https://developer.chrome.com/blog/chrome-for-testing）
はネイティブ書き出しのオーバーレイ撮影に使う（`src/server/captureDriver.ts` が
`playwright-core` 経由で起動する）。版は `src/server/resolveChromium.ts` の
`CHROME_HEADLESS_SHELL_VERSION` に固定。取得元は Google 公式バケット
（`https://storage.googleapis.com/chrome-for-testing-public`）を第一、Playwright の CDN
ミラー（`https://cdn.playwright.dev/builds/cft`）を退避とする。
ライセンスは Chromium 本体が BSD-3-Clause、加えて**同梱されている第三者コンポーネントは
それぞれ固有のライセンス**（MIT・Apache-2.0・LGPL など多数）に従う。その一覧と全文は
展開後の `tools/chrome-headless-shell/**/LICENSE.headless_shell` に含まれる
（配置された実体そのものが通知を持つ）。ソースの改変は行っていない。

### jellyfin-ffmpeg (GPL)

`ffmpeg` / `ffprobe`（https://github.com/jellyfin/jellyfin-ffmpeg）は音声波形の解析と
書き出しに使う。macOS の `setup.command` が GPL ビルドの静的バイナリを SHA-256 照合
つきでダウンロードし `tools/ffmpeg`・`tools/ffprobe` へ配置する（Windows は winget /
手動導入のみ）。無改変のまま実行ファイルとして利用しており、本リポジトリは
ffmpeg のソースもバイナリも同梱・再配布していない。取得元は
`https://github.com/jellyfin/jellyfin-ffmpeg` の releases。

### 自動導入に失敗したときの案内先（ダウンロードはしない）

setup スクリプトは自動導入に失敗したとき、利用者に次の配布元を手動で案内する
（スクリプト自身はここから取得しない）。ホストを Notices に載せておくのは、
`thirdPartyNotices.test.ts` が setup 内の https ホストを機械的に突き合わせて、
**新しい取得元が黙って増えること**を検出できるようにするため（I-6）。

- `https://ffmpeg.org/download.html` — ffmpeg 公式（macOS 手動導入の案内先）
- `https://www.gyan.dev/ffmpeg/builds/` — Windows 版 ffmpeg ビルドの配布元（手動導入の案内先）

## xterm.js (MIT License)

`@xterm/xterm` and `@xterm/addon-fit` (https://github.com/xtermjs/xterm.js)
render the embedded `claude` terminal in `src/app/panels/ClaudeTerminal.tsx`.
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

0.3.1 までの案件（旧形式）の部品には、Remotion（https://www.remotion.dev/）向けの原文が含まれます。
エディタ本体の実行依存からの除去後も、過去の出自と権利表示は保持します。外部の Remotion 環境で素材を制作する場合は、その環境の条件を確認してください。
Remotion は MIT ではなく独自ライセンス（Remotion License）で提供されています。
個人および従業員3名までの組織は無料で利用できますが、4名以上の組織では
別途カンパニーライセンスが必要になる場合があります。
詳細: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md

## 同梱フォント（public/fonts/）

SIL Open Font License 1.1。書体の一覧と原本は `public/fonts/LICENSES.md` と `public/fonts/fonts.manifest.json`、
書体ごとのライセンス全文は `public/fonts/licenses/` にある。サブセット化のほかに改変はしていない。

## Cuelume（src/lib/vendor/cuelume/）

MIT License. UI 操作音（Web Audio 合成・依存ゼロ）。原本と入手経路は `src/lib/vendor/cuelume/PROVENANCE.md`。改変なし。
