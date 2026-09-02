@echo off
setlocal

REM Activate venv if exists, else use system python
if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
) else (
    echo WARNING: .venv not found, using system Python
    echo Run scripts\install.bat first for isolated install.
    echo.
)

echo Starting PC Phone Speaker...
echo.

REM Detect LAN IP and show helpful firewall note
python -m backend.main %*

if errorlevel 1 (
    echo.
    echo Server exited with error.
    echo.
    echo Troubleshooting:
    echo   - Port in use? Try: scripts\start.bat --port 8081
    echo   - Firewall blocking? Allow Python through Windows Firewall:
    echo     Settings ^> Privacy ^& security ^> Windows Security ^> Firewall ^> Allow an app
    echo     Find "Python" and enable Private networks.
    echo   - Same Wi-Fi? Phone and PC must be on the same network.
    echo   - Run diagnostic: python -m backend.main --diagnostic
    pause
)
