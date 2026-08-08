@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 動画プロジェクトが並ぶ親フォルダ。別の場所を使いたければ書き換える。
rem 新変数 → 旧変数（SME_PROJECT_ROOT・後方互換）→ 既定値（このフォルダ内の projects\）の順で解決する
if "%HARNESS_PROJECT_ROOT%"=="" if not "%SME_PROJECT_ROOT%"=="" set "HARNESS_PROJECT_ROOT=%SME_PROJECT_ROOT%"
if "%HARNESS_PROJECT_ROOT%"=="" set "HARNESS_PROJECT_ROOT=%~dp0projects"
if not exist "%HARNESS_PROJECT_ROOT%" mkdir "%HARNESS_PROJECT_ROOT%"

rem ffmpeg が PATH に無い場合は、ffmpeg.exe のフルパスをここで指定できる。
rem 例: set "HARNESS_FFMPEG=C:\ffmpeg\bin\ffmpeg.exe"

rem 課金ガード: ANTHROPIC_API_KEY があると Claude Code がサブスクでなく API 課金に切り替わる。
if not "%ANTHROPIC_API_KEY%"=="" (
  echo [注意] ANTHROPIC_API_KEY が設定されています。
  echo        Claude Code がサブスクではなく API レート課金に切り替わるため、ブリッジ常駐は危険です。
  echo        解除してから常駐してください（このウィンドウで: set ANTHROPIC_API_KEY=）。
)

echo     画面から Claude に指示するには docs/claude-bridge-loop.md を参照（MCP 接続 + /loop 常駐）。
echo == Harness Editor を起動します
echo    プロジェクト置き場: %HARNESS_PROJECT_ROOT%
echo    ブラウザが自動で開きます。このウィンドウは閉じないでください
echo    （閉じるとエディタも止まります）。
echo    終了するにはこのウィンドウを閉じるか、Ctrl+C を押してください。
echo.
call npm start
pause
