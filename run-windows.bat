@echo off
echo [ACORE] Image ellenorzese...
docker images | findstr /R /C:"^acore " >nul
if errorlevel 1 (
    echo [ACORE] Image nem talalhato, build indulas...
    docker build -t acore .
    if errorlevel 1 (
        echo [ACORE] HIBA: A build sikertelen volt!
        exit /b 1
    )
) else (
    echo [ACORE] Image megtalalva, build kihagyva.
)

echo [ACORE] Kontener inditasa...
docker run -it --rm -v "%cd%/configs:/host-configs" -p 8085:8085 -p 3724:3724 -p 3310:3310 -p 8000:8000 acore
