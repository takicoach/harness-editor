@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: M-10: 自分の置き場所は最初に 1 回だけ取る。サブルーチン（:label）の中の %~dp0 は
:: 「呼ばれ方によって別物を指すのでは」と読む側が毎回確かめる羽目になるので、
:: 以降は %HE_ROOT% だけを使う（末尾に \ が付いた形）
set "HE_ROOT=%~dp0"

:: Node.js の下限。独自プレビューのmp4boxは20.8.1以上を必要とする。
:: noble/hashesとpackage enginesに合わせ20.19を下限にする（--importの下限20.6も満たす）。
:: 値は toolchainPins.test.ts が setup.command / package.json の engines と現物突合する。
set "NODE_MIN_MAJOR=20"
set "NODE_MIN_MINOR=19"
set "NODE_MIN_LABEL=20.19"

:: 撮影エンジン（Chrome for Testing の chrome-headless-shell・テロップ入りの高速書き出しで使う）
:: 版は src\server\resolveChromium.ts の CHROME_HEADLESS_SHELL_VERSION と同じ値にすること
:: （toolchainPins.test.ts が両者の一致を機械検査する）。版を上げるときは SHA-256 も入れ替える。
:: Mac 用（mac-arm64 / mac-x64）のハッシュは setup.command 側が持つ。
:: I-2: SHA-256 には「どの版のハッシュか」を直上の行に併記する。版だけ上げてハッシュを
:: 据え置く片肺更新を toolchainPins.test.ts が赤で止める（併記が無い場合も赤）。
:: I-1: 併記は貼り忘れしか見ない。ハッシュの取り違えは版上げのたびに
:: HARNESS_VERIFY_CHROMIUM_SHA=1 npx vitest run src/server/toolchainPins.test.ts で
:: 配布元の現物と突き合わせて確かめること。
set "CHROMIUM_VERSION=148.0.7778.96"
:: for 148.0.7778.96
set "CHROMIUM_SHA256_WIN64=492367a1cd439403ccb82adeb47b02b17965e3dcd5fbaf2d8fa3eca34941496a"

echo == Harness Editor のセットアップを開始します
echo.

:: ---- 1. 動画処理エンジン（ffmpeg）----
echo == 動画処理エンジン（ffmpeg）を確認します
call :check_ffmpeg
if defined FFMPEG_FOUND (
  echo [OK] ffmpeg は導入済みです。
  goto ffmpeg_done
)

where winget >nul 2>nul
if errorlevel 1 goto ffmpeg_manual

echo == winget で ffmpeg をインストールします（数分かかります）
winget install --id Gyan.FFmpeg -e --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if errorlevel 1 goto ffmpeg_manual

:: winget が「成功」と言っても、この画面ではまだ PATH に載っていないことがある。
:: 実体が見えたときだけ「使える状態」と表示する。
call :check_ffmpeg
if defined FFMPEG_FOUND (
  echo [OK] ffmpeg を使える状態になりました。
  goto ffmpeg_done
)
echo [注意] インストールは終わりましたが、この画面からはまだ ffmpeg を見つけられません。
echo        パソコンを再起動してから、もう一度 setup.bat を実行してください。
goto ffmpeg_done

:ffmpeg_manual
echo [NG] ffmpeg を自動で入れられませんでした。
echo      PowerShell を開いて  winget install ffmpeg  を実行してください。
echo      うまくいかない場合は https://www.gyan.dev/ffmpeg/builds/ から zip をダウンロードし、
echo      中身を C:\ffmpeg\bin へ置いてください（C:\ffmpeg\bin\ffmpeg.exe になるように）。
echo      ffmpeg が無くても編集画面は開けますが、音声波形や書き出しなど一部の機能が使えません。

:ffmpeg_done
echo.

:: ---- 2. Node.js ----
echo == Node.js を確認します
where node >nul 2>nul
if errorlevel 1 goto node_install

:: I-1: `node -v` が何も出さなければ for /f は本体を 1 度も回さない。先に空へ置いておかないと
::      前の値が残ったまま比較され、古い Node でも素通りしうる（fail-open）。取れなければ
::      インストーラ経路へ落とす（mac 側の case で空と非数字を弾いているのと対称）
set "NODE_MAJOR="
set "NODE_MINOR="
set "NODE_VER="
for /f "tokens=1,2 delims=v." %%A in ('node -v') do (set "NODE_MAJOR=%%A"& set "NODE_MINOR=%%B")
for /f %%V in ('node -v') do set NODE_VER=%%V
if not defined NODE_MAJOR goto node_install
if not defined NODE_MINOR goto node_install
:: 数字以外（想定外の書式・token が展開されなかった等）も弾く。ここを通れば LSS 比較は数値比較
echo !NODE_MAJOR!!NODE_MINOR!| findstr /r /c:"^[0-9][0-9]*$" >nul
if errorlevel 1 goto node_install
:: I-1: major だけでなく minor まで見る（20.0〜20.5 では `node --import` が使えない）
if !NODE_MAJOR! LSS %NODE_MIN_MAJOR% goto node_install
if !NODE_MAJOR! EQU %NODE_MIN_MAJOR% if !NODE_MINOR! LSS %NODE_MIN_MINOR% goto node_install
echo [OK] Node.js: !NODE_VER!
goto node_done

:node_install
:: ここから先はファイルのパスを扱うため、遅延展開を切る（パスに ! が含まれても壊れないように）
setlocal DisableDelayedExpansion
echo [NG] Node.js が入っていない、またはバージョンが古いです（%NODE_MIN_LABEL% 以上が必要）。
echo == nodejs.org から LTS 版のインストーラをダウンロードします（80MB ほど）
echo    ダウンロード後、公式の SHASUMS256.txt と照合してから開きます。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $v = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version; $arch = 'x64'; if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }; $file = 'node-' + $v + '-' + $arch + '.msi'; $base = 'https://nodejs.org/dist/' + $v + '/'; $out = Join-Path $env:TEMP 'harness-editor-node-lts.msi'; if (([uri]($base + $file)).Scheme -ne 'https') { exit 4 }; Invoke-WebRequest -Uri ($base + $file) -OutFile $out -UseBasicParsing -MaximumRedirection 5; $sums = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing).Content; $m = [regex]::Match($sums, '([0-9a-fA-F]{64})\s+' + [regex]::Escape($file)); if (-not $m.Success) { Remove-Item $out -Force; exit 2 }; $hash = (Get-FileHash -Algorithm SHA256 -Path $out).Hash; if ($hash -ne $m.Groups[1].Value.ToUpper()) { Remove-Item $out -Force; exit 3 }; Write-Output $out" > "%TEMP%\he-node-msi.txt"
if errorlevel 1 goto node_manual

set "NODE_MSI="
set /p NODE_MSI=<"%TEMP%\he-node-msi.txt"
del "%TEMP%\he-node-msi.txt" >nul 2>nul
if not defined NODE_MSI goto node_manual
if not exist "%NODE_MSI%" goto node_manual

echo == インストーラを開きます。画面の指示に従って進めてください。
start "" "%NODE_MSI%"
echo.
echo 次にすること: Node.js のインストールが終わったら、もう一度 setup.bat をダブルクリックしてください。
echo （このウィンドウは閉じて大丈夫です）
echo.
pause
exit /b 0

:node_manual
echo [NG] インストーラを用意できませんでした（ダウンロード失敗、または公式の照合と不一致）。
echo      https://nodejs.org/ja から LTS 版（%NODE_MIN_LABEL% 以上）をインストールしてください。
echo.
pause
exit /b 1

:node_done
echo.

:: ---- 3. 部品のインストール ----
echo == npm install を実行します（初回は数分かかります）
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [NG] npm install に失敗しました。上のエラーメッセージを確認してください。
  echo.
  pause
  exit /b 1
)

:: I-1: @resvg/resvg-js（図形オーバーレイの PNG ラスタライズ）はネイティブアドオン。
:: 対応外プラットフォームで prebuild が取れないと書き出し時に初めて失敗しがちなので、
:: ここで一度だけ require 可否を確認する（失敗しても致命的にはせず案内だけ出す）。
call node -e "require('@resvg/resvg-js')" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [注意] 図形（矢印・線・枠など）の書き出し用ライブラリ（@resvg/resvg-js）の読み込みに失敗しました。
  echo        図形を使わない書き出しには影響しません。図形を使う場合は npm install をやり直してください。
  echo.
)

:: ---- 4. 撮影エンジン（テロップ入りの高速書き出しで使う Chromium）----
:: M-8: テスト用の環境変数 HE_SETUP_SKIP_CHROMIUM=1 で撮影エンジンの導入をとばす
:: （setup.command の同名の変数と同じ役割。ふだんの利用では設定しません）
echo.
if defined HE_SETUP_SKIP_CHROMIUM (
  echo == 撮影エンジンの導入はスキップしました（テスト用の設定）
  goto chromium_done
)
echo == 撮影エンジン（テロップ入りの高速書き出し用）を確認します
:: M-9: 記録は実行ごとに世代を分け、1 世代前だけ残す（.log.1）。追記だけだと再実行のたびに
:: 膨らみ、今回の実行の記録がどこから始まるかも読み取りにくい。失敗しても導入は止めない。
if exist "%HE_ROOT%tools\chromium-setup.log" move /y "%HE_ROOT%tools\chromium-setup.log" "%HE_ROOT%tools\chromium-setup.log.1" >nul 2>nul
call :install_chromium
if errorlevel 1 (
  echo.
  echo [注意] 追加の撮影エンジン（headless shell）を導入できませんでした。setupは続行します。
  echo        このあと独自書き出し用の通常版Chromeを確認します。利用できるかは、その確認結果をご覧ください。
  echo        setup.bat をもう一度実行すると再試行します。
)
:chromium_done
set "NATIVE_CHROMIUM_FAILED="
if not defined HE_SETUP_SKIP_CHROMIUM (
  echo == 独自書き出し用ブラウザ（通常版Chrome）を確認します
  call node --import tsx scripts/native-chromium-setup.ts
  if errorlevel 1 (
    set "NATIVE_CHROMIUM_FAILED=1"
    echo [注意] 独自書き出しは利用できません。setup.bat を再実行してください。
  )
)

echo.
if defined NATIVE_CHROMIUM_FAILED (
  echo [注意] セットアップ未完了。独自書き出し用ブラウザを導入できませんでした。setup.bat を再実行してください。
) else (
  echo [OK] セットアップ完了。
)
echo.
echo 次回からは start.bat をダブルクリックでエディタを起動できます。
echo 起動後は、画面右の AI タブから AI に編集を頼めます（接続は自動）。
echo.
pause
if defined NATIVE_CHROMIUM_FAILED exit /b 1
exit /b 0

:: ---- 撮影エンジンの動作確認（実際に起動して 1×1 の画を 1 枚撮る）----
:: 検査したい実体は必ず HARNESS_CHROMIUM で明示する。渡さないと PC に元からある
:: 別の実体を見て「OK」になってしまい、いま置いたものの検査にならない
:: I-4: 生の出力は tools\chromium-setup.log に残す（画面には出さず、失敗時にそこを案内する）
:chromium_health
setlocal
set "HARNESS_CHROMIUM=%~1"
if not exist "%HE_ROOT%tools" mkdir "%HE_ROOT%tools"
:: M-8: `echo ... %~1>>file` は、パスが数字で終わると末尾の数字が
:: リダイレクト先のハンドル番号として食われる。値は引用し、リダイレクトを先頭に置く
>>"%HE_ROOT%tools\chromium-setup.log" echo --- %DATE% %TIME% health "%~1"
call node --import tsx scripts\chromium-health.ts >>"%HE_ROOT%tools\chromium-setup.log" 2>&1
endlocal & exit /b %errorlevel%

:: ---- 起動できない実体を .broken へ退避するサブルーチン（I-3）----
:: 消さずに退避するので、原因調査とロールバックの余地が残る。
:: M-5: 消す/動かす相手が tools フォルダの中であることを PowerShell 側で確かめる（exit 6）
:retire_broken_chromium
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$env:CHROMIUM_DIR; if ($d.Contains('..') -or -not $d.StartsWith($env:CHROMIUM_TOOLS_ROOT, [StringComparison]::OrdinalIgnoreCase)) { exit 6 }; if (Test-Path ($d + '.broken')) { Remove-Item ($d + '.broken') -Recurse -Force }; Move-Item -Path $d -Destination ($d + '.broken')"
if errorlevel 1 (
  echo [NG] 起動できない撮影エンジンを退避できませんでした。
  exit /b 1
)
echo [注意] 既にあった撮影エンジンが起動できなかったので、同じ場所の .broken へ退避しました。入れ直します。
exit /b 0

:: ---- 撮影エンジンをダウンロードして tools フォルダに配置するサブルーチン ----
:: 配置先のパスは health スクリプト（--print-tools-path）だけが知っている
:: ＝置き場所の規約をこのファイルに二重に書かない
:install_chromium
:: ここから先はファイルのパスを扱うため、遅延展開を切る（パスに ! が含まれても壊れないように）
setlocal DisableDelayedExpansion
set "CHROMIUM_TOOLS_ROOT=%HE_ROOT%tools\"
set "CHROMIUM_LOG=%CHROMIUM_TOOLS_ROOT%chromium-setup.log"
set "CHROMIUM_ERR=%CHROMIUM_TOOLS_ROOT%.chromium-tools-path.err"
if not exist "%CHROMIUM_TOOLS_ROOT%" mkdir "%CHROMIUM_TOOLS_ROOT%"

set "CHROMIUM_DIR="
for /f "usebackq delims=" %%P in (`node --import tsx scripts\chromium-health.ts --print-tools-path 2^>"%CHROMIUM_ERR%"`) do set "CHROMIUM_DIR=%%P"
type "%CHROMIUM_ERR%" >>"%CHROMIUM_LOG%" 2>nul
:: M-11 / M-5: 配置先を出せない理由は 3 つあり、利用者の取るべき行動が違う。
:: 「未対応の CPU」は打つ手が無い／「Node が古い」は Node を入れ直す／
:: 「部品の導入が未完了」は setup をやり直す（setup.command の 3 枝と同じ分け方）
if not defined CHROMIUM_DIR (
  findstr /b /c:"unsupported-platform:" "%CHROMIUM_ERR%" >nul 2>nul
  if errorlevel 1 (
    rem M-5: 20.6 未満の Node は `--import` を未知のオプションとして扱い、stderr に
    rem `node: bad option: --import` を出して落ちる（ESM 側で弾かれる版は ERR_UNKNOWN_*）。
    rem この signature が出ているときだけ Node 版の案内にする（mac 側と同じ判定）
    findstr /i /c:"bad option: --import" /c:"ERR_UNKNOWN" "%CHROMIUM_ERR%" >nul 2>nul
    if errorlevel 1 (
      echo [NG] 撮影エンジンの導入準備ができていません（部品の導入が未完了の可能性があります）。
      echo      npm install が終わった状態で setup.bat をもう一度実行してください。
      echo      詳しい記録: tools\chromium-setup.log
    ) else (
      echo [NG] 撮影エンジンの導入準備ができていません（Node.js の版が古い可能性があります）。
      echo      コマンドプロンプトで node -v を実行し、%NODE_MIN_LABEL% 以上か確認してください。
      echo      詳しい記録: tools\chromium-setup.log
    )
  ) else (
    echo [NG] この PC の OS/CPU は撮影エンジンに対応していません。
  )
  del "%CHROMIUM_ERR%" >nul 2>nul
  endlocal & exit /b 1
)
del "%CHROMIUM_ERR%" >nul 2>nul
set "CHROMIUM_STAGED=%CHROMIUM_DIR%.new"

:: I-5: 配布物の platform 名も health スクリプトの出力に従う
:: （PROCESSOR_ARCHITECTURE での CPU 判定をこのファイルに二重に書かない）
set "CHROMIUM_PLATFORM="
for /f "usebackq delims=" %%P in (`node --import tsx scripts\chromium-health.ts --print-download-platform 2^>>"%CHROMIUM_LOG%"`) do set "CHROMIUM_PLATFORM=%%P"
if not defined CHROMIUM_PLATFORM (
  :: M-8: 空は「対応外の CPU」ではなく「platform を取得できなかった」。取るべき行動が違う
  echo [NG] 配布物の platform を取得できませんでした（部品の導入が未完了、または Node.js の版が古い可能性があります）。
  echo      npm install が終わった状態で、node -v が %NODE_MIN_LABEL% 以上であることを確認してから setup.bat をもう一度実行してください。
  echo      詳しい記録: tools\chromium-setup.log
  endlocal & exit /b 1
)
if not "%CHROMIUM_PLATFORM%"=="win64" (
  echo [NG] この PC 向けの配布物のハッシュが setup.bat にありません（%CHROMIUM_PLATFORM%）。
  endlocal & exit /b 1
)

:: 同じ版の実体が既にあって、実際に起動できるならそのまま使う
:: （版はパスに含まれるので、古い版のフォルダは残しても混ざらない＝戻せるように消さない）
if exist "%CHROMIUM_DIR%\chrome-headless-shell.exe" (
  call :chromium_health "%CHROMIUM_DIR%\chrome-headless-shell.exe"
  if not errorlevel 1 (
    echo [OK] 撮影エンジンは導入済みです。
    endlocal & exit /b 0
  )
  :: I-3: 起動できない実体をその場に残すと、次回もここで引っかかり続ける
  call :retire_broken_chromium
  if errorlevel 1 (
    endlocal & exit /b 1
  )
)

echo == 撮影エンジンをダウンロードして tools フォルダに入れます（100MB ほど・回線次第で数分）
echo    ダウンロード後、想定の SHA-256 と照合してから展開します。
:: いったん仮の名前（.new）で置き、動作確認が済んでから本番の名前へ差し替える（ffmpeg と同じ順序）
:: C-1: zip も展開先も %TEMP% ではなく tools フォルダの直下に取る（同じボリューム）。
::      %TEMP% が別ボリュームだと Move-Item がボリュームをまたいで失敗するため。
::      try/finally で zip と展開先は必ず片付ける。
:: M-2: 作業先は配置先の隣（<配置先>.new.zip）ではなく tools 直下の短い名前にする。
::      配置先は版と platform を含む深いパスなので、そこに .new.unpack を足して
::      さらに書庫の中身を展開すると MAX_PATH（260 文字）に当たりやすい。
:: M-2: 取得の失敗（2/3）と、展開・配置の失敗（5）を別の exit code にして文言を分ける。
:: M-4: exit を try の中で使うと finally との兼ね合いが処理系まかせになる。
::      結果は $code に入れて、最後に 1 か所だけで exit する。
:: M-5: 配置先が tools フォルダの外なら何もせず 6 で抜ける。
:: M-9: 進捗バーの描画（既定で有効）は非対話実行だと極端に遅いので切る。
::      取得先は https のみ（リダイレクト先も最終応答の scheme で確かめる）。
:: I-5: 例外は握り潰さず tools\chromium-setup.log に残す（画面には出さない）。
:: M-1: Unblock-File は保険。curl/Invoke-WebRequest 経由の取得では Zone.Identifier が
::      付かないことが多いが、付いた場合に Gatekeeper 相当の警告で起動が止まるのを防ぐ
::      （印が無ければ何も起きない）。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=$env:CHROMIUM_PLATFORM; $name='chrome-headless-shell-' + $p + '.zip'; $urls=@('https://storage.googleapis.com/chrome-for-testing-public/' + $env:CHROMIUM_VERSION + '/' + $p + '/' + $name, 'https://cdn.playwright.dev/builds/cft/' + $env:CHROMIUM_VERSION + '/' + $p + '/' + $name); $root=$env:CHROMIUM_TOOLS_ROOT; $staged=$env:CHROMIUM_STAGED; $log=$env:CHROMIUM_LOG; $zip=$root + '.chromium-dl.zip'; $unpack=$root + '.chromium-dl.unpack'; $code=0; if ($staged.Contains('..') -or -not $staged.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $code=6 }; if ($code -eq 0) { try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staged) | Out-Null; $got=$false; foreach ($u in $urls) { try { if (([uri]$u).Scheme -ne 'https') { throw ('insecure url: ' + $u) }; $r=Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -MaximumRedirection 5 -PassThru; $b=$r.BaseResponse; $s=if ($b.ResponseUri) { $b.ResponseUri.Scheme } elseif ($b.RequestMessage) { $b.RequestMessage.RequestUri.Scheme } else { 'https' }; if ($s -ne 'https') { throw ('insecure redirect: ' + $u) }; $got=$true; break } catch { ($_ | Out-String) | Add-Content -LiteralPath $log } }; if (-not $got) { $code=2 } elseif ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash -ne $env:CHROMIUM_SHA256_WIN64.ToUpper()) { $code=3 } else { if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }; Expand-Archive -Path $zip -DestinationPath $unpack -Force; $src=Get-ChildItem -Path $unpack -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'chrome-headless-shell.exe') } | Select-Object -First 1; if ($null -eq $src) { $code=4 } else { Get-ChildItem -Path $src.FullName -Recurse -File | Unblock-File; if (Test-Path $staged) { Remove-Item $staged -Recurse -Force }; Move-Item -Path $src.FullName -Destination $staged } } } catch { ($_ | Out-String) | Add-Content -LiteralPath $log; $code=5 } finally { if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }; if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue } } }; exit $code"
:: M-3: PowerShell 自体を起動できないと cmd が 9009 を返す。これを 6 以下の
::      「PowerShell が返した番号」と読み違えないよう、いちばん先に見る
if errorlevel 9000 (
  echo [NG] PowerShell を起動できませんでした（この PC では利用できない可能性があります）。
  echo      詳しい記録: tools\chromium-setup.log
  endlocal & exit /b 1
)
if errorlevel 6 (
  echo [NG] 撮影エンジンの配置先が想定外の場所でした。安全のため中止しました。
  endlocal & exit /b 1
)
if errorlevel 5 (
  echo [NG] ダウンロードはできましたが、展開または配置に失敗しました。
  echo      ディスクの空き容量とウイルス対策ソフトの設定を確認してから、もう一度実行してください。
  echo      詳しい記録: tools\chromium-setup.log
  endlocal & exit /b 1
)
if errorlevel 4 (
  echo [NG] ダウンロードしたファイルの中身が想定と違いました。
  endlocal & exit /b 1
)
if errorlevel 3 (
  echo [NG] ダウンロードしたファイルの中身が想定と違いました（通信の失敗か、配布元の更新が考えられます）。
  endlocal & exit /b 1
)
if errorlevel 1 (
  echo [NG] 撮影エンジンをダウンロードできませんでした。
  echo      詳しい記録: tools\chromium-setup.log
  endlocal & exit /b 1
)

call :chromium_health "%CHROMIUM_STAGED%\chrome-headless-shell.exe"
if errorlevel 1 (
  echo [NG] 撮影エンジンを起動できませんでした。
  echo      詳しい記録: tools\chromium-setup.log
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { if (Test-Path $env:CHROMIUM_STAGED) { Remove-Item $env:CHROMIUM_STAGED -Recurse -Force } } catch { ($_ | Out-String) | Add-Content -LiteralPath $env:CHROMIUM_LOG }"
  endlocal & exit /b 1
)
:: M-5: 消す/動かす相手が tools フォルダの中であることを確かめてから差し替える
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $code=0; $d=$env:CHROMIUM_DIR; if ($d.Contains('..') -or -not $d.StartsWith($env:CHROMIUM_TOOLS_ROOT, [StringComparison]::OrdinalIgnoreCase)) { $code=6 } else { try { if (Test-Path $d) { Remove-Item $d -Recurse -Force }; Move-Item -Path $env:CHROMIUM_STAGED -Destination $d } catch { ($_ | Out-String) | Add-Content -LiteralPath $env:CHROMIUM_LOG; $code=5 } }; exit $code"
if errorlevel 1 (
  echo [NG] 撮影エンジンを所定の場所へ移せませんでした。
  echo      詳しい記録: tools\chromium-setup.log
  endlocal & exit /b 1
)
echo [OK] 撮影エンジンを入れました。
endlocal & exit /b 0

:: ---- ffmpeg の実体を探すサブルーチン（PATH と定番の置き場所）----
:check_ffmpeg
set "FFMPEG_FOUND="
where ffmpeg >nul 2>nul
if not errorlevel 1 set FFMPEG_FOUND=1
if exist "C:\ffmpeg\bin\ffmpeg.exe" set FFMPEG_FOUND=1
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set FFMPEG_FOUND=1
if exist "%HE_ROOT%tools\ffmpeg.exe" set FFMPEG_FOUND=1
goto :eof
