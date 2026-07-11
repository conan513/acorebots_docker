@echo off
echo [ACORE] Checking image...
docker images | findstr /R /C:"^acore " >nul
if errorlevel 1 (
    echo [ACORE] Image not found, starting build...
    docker build -t acore .
    if errorlevel 1 (
        echo [ACORE] ERROR: Build failed!
        exit /b 1
    )
) else (
    echo [ACORE] Image found, skipping build.
)

if "%REALM_IP%"=="" (
    for /f "tokens=4" %%i in ('route print ^| findstr 0.0.0.0 ^| findstr /V "127.0.0.1" 2^>nul') do (
        set REALM_IP=%%i
    )
)

if "%REALM_IP%"=="" (
    set REALM_IP=127.0.0.1
)

echo [ACORE] Detected Host LAN IP: %REALM_IP%
echo [ACORE] Starting container...

docker run -it --rm --name acore-server -e REALM_IP="%REALM_IP%" -v "%cd%/configs:/host-configs" -v acore-bin:/opt/acore -v acore-source:/acore -p 8085:8085 -p 3724:3724 -p 3310:3310 -p 8000:8000 --cap-add SYS_NICE --cap-add IPC_LOCK --ulimit memlock=-1 acore
