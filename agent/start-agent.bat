@echo off
chcp 65001 >nul
title Thai ID Card Agent - People's Party
cd /d "%~dp0"
echo ============================================
echo   Thai ID Card Agent - People's Party
echo ============================================
echo.

REM ติดตั้ง pyscard ถ้ายังไม่มี
python -c "import smartcard" 2>nul
if errorlevel 1 (
  echo [setup] กำลังติดตั้ง pyscard ...
  python -m pip install --quiet pyscard
)

echo [run] กำลังเริ่ม agent ...
echo เปิดเว็บแอปแล้วกดปุ่ม "อ่านบัตรประชาชน"
echo.
python idcard_agent.py
pause
