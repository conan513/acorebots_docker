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

docker run -it --rm --name acore-server -v "%cd%/configs:/host-configs" -v acore-bin:/opt/acore -v acore-source:/acore -p 8085:8085 -p 3724:3724 -p 3310:3310 -p 8000:8000 --cap-add SYS_NICE --cap-add IPC_LOCK --ulimit memlock=-1 acore
