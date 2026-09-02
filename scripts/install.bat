@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo   PC Phone Speaker - Installer
echo ============================================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found in PATH.
    echo Please install Python 3.12+ from https://www.python.org/
    echo Make sure to check "Add python.exe to PATH" during install.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Found Python %PYVER%

REM Check Python version >= 3.10
python -c "import sys; exit(0 if sys.version_info>=(3,10) else 1)" 2>nul
if errorlevel 1 (
    echo ERROR: Python 3.10+ required. Found %PYVER%
    pause
    exit /b 1
)

REM Create venv if not exists
if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo ERROR: Failed to create venv
        pause
        exit /b 1
    )
) else (
    echo Virtual environment already exists.
)

echo Activating venv and installing dependencies...
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo ERROR: Failed to activate venv
    pause
    exit /b 1
)

echo Upgrading pip...
python -m pip install --upgrade pip

echo Installing dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo Verifying packages...
python -c "import fastapi, uvicorn, aiortc, av, numpy, qrcode; print('  fastapi OK'); print('  uvicorn OK'); print('  aiortc OK')"
if errorlevel 1 (
    echo WARNING: Some packages failed to import
)

python -c "import pyaudiowpatch; pa=pyaudiowpatch.PyAudio(); print(f'  pyaudiowpatch OK ({pa.get_device_count()} devices)'); pa.terminate()" 2>nul
if errorlevel 1 (
    echo WARNING: pyaudiowpatch check failed - audio capture may not work
)

echo.
echo ============================================================
echo   Install complete!
echo   Run scripts\start.bat to launch the server.
echo ============================================================
pause
