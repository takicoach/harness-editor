@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

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

for /f "tokens=1 delims=v." %%A in ('node -v') do set NODE_MAJOR=%%A
for /f %%V in ('node -v') do set NODE_VER=%%V
if !NODE_MAJOR! LSS 20 goto node_install
echo [OK] Node.js: !NODE_VER!
goto node_done

:node_install
:: ここから先はファイルのパスを扱うため、遅延展開を切る（パスに ! が含まれても壊れないように）
setlocal DisableDelayedExpansion
echo [NG] Node.js が入っていない、またはバージョンが古いです（20 以上が必要）。
echo == nodejs.org から LTS 版のインストーラをダウンロードします（80MB ほど）
echo    ダウンロード後、公式の SHASUMS256.txt と照合してから開きます。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version; $arch = 'x64'; if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }; $file = 'node-' + $v + '-' + $arch + '.msi'; $base = 'https://nodejs.org/dist/' + $v + '/'; $out = Join-Path $env:TEMP 'harness-editor-node-lts.msi'; Invoke-WebRequest -Uri ($base + $file) -OutFile $out -UseBasicParsing; $sums = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing).Content; $m = [regex]::Match($sums, '([0-9a-fA-F]{64})\s+' + [regex]::Escape($file)); if (-not $m.Success) { Remove-Item $out -Force; exit 2 }; $hash = (Get-FileHash -Algorithm SHA256 -Path $out).Hash; if ($hash -ne $m.Groups[1].Value.ToUpper()) { Remove-Item $out -Force; exit 3 }; Write-Output $out" > "%TEMP%\he-node-msi.txt"
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
echo      https://nodejs.org/ja から LTS 版（20 以上）をインストールしてください。
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

echo.
echo [OK] セットアップ完了。
echo.
echo 次回からは start.bat をダブルクリックでエディタを起動できます。
echo 起動後は、画面右の AI タブから AI に編集を頼めます（接続は自動）。
echo.
pause
exit /b 0

:: ---- ffmpeg の実体を探すサブルーチン（PATH と定番の置き場所）----
:check_ffmpeg
set "FFMPEG_FOUND="
where ffmpeg >nul 2>nul
if not errorlevel 1 set FFMPEG_FOUND=1
if exist "C:\ffmpeg\bin\ffmpeg.exe" set FFMPEG_FOUND=1
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set FFMPEG_FOUND=1
if exist "%~dp0tools\ffmpeg.exe" set FFMPEG_FOUND=1
goto :eof
