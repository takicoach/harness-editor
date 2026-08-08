@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo == Harness Editor のセットアップを開始します
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [NG] Node.js がインストールされていません。
  echo      https://nodejs.org/ から LTS 版 20 以上 をインストールしてください。
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%A in ('node -v') do set NODE_MAJOR=%%A
for /f %%V in ('node -v') do set NODE_VER=%%V
if !NODE_MAJOR! LSS 20 (
  echo [NG] Node.js のバージョンが古いです（!NODE_VER!）。20 以上が必要です。
  echo      https://nodejs.org/ から最新の LTS をインストールしてください。
  echo.
  pause
  exit /b 1
)

echo == Node.js: !NODE_VER!
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
echo Claude Code でプロジェクトを作っている横で、エディタも開いておくと便利です。
echo.
pause
