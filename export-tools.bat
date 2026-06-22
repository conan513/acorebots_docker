@echo off
REM ============================================================
REM  AzerothCore Tools Export Script (Windows)
REM ============================================================

set IMAGE_NAME=acore:latest
set OUTPUT_DIR=wow-tools

echo ==============================================
echo   AzerothCore Tools Exporter
echo ==============================================
echo.

REM 1) Ellenorizzuk, hogy letezik-e az acore image
docker images -q %IMAGE_NAME% >nul 2>&1
if errorlevel 1 (
    docker images -q acore >nul 2>&1
    if errorlevel 1 (
        echo HIBA: Az %IMAGE_NAME% docker image nem talalhato!
        echo Kerlek elobb inditsd el a szerver buildet (pl. run-windows.bat vagy az admin feluleten),
        echo hogy letrejoojon a Docker image a beepitett toolokkal.
        pause
        exit /b 1
    ) else (
        set TARGET_IMAGE=acore
    )
) else (
    set TARGET_IMAGE=%IMAGE_NAME%
)

echo Talalt image: %TARGET_IMAGE%
echo.

REM 2) Kimenet mappa
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
echo [1/2] Toolok kimasolasa a(z) %TARGET_IMAGE% image-bol -- %OUTPUT_DIR%

REM Ideiglenes konteiner ID lekerdezese
for /f %%i in ('docker create %TARGET_IMAGE%') do set CONTAINER_ID=%%i

REM Toolok masolasa
(docker cp %CONTAINER_ID%:/opt/acore/bin/map_extractor "%OUTPUT_DIR%/" 2>nul && echo       OK: map_extractor) || (docker cp %CONTAINER_ID%:/opt/acore/bin/mapextractor "%OUTPUT_DIR%/" 2>nul && echo       OK: mapextractor) || echo       SKIP: mapextractor (nem talalhato)

(docker cp %CONTAINER_ID%:/opt/acore/bin/vmap4_extractor "%OUTPUT_DIR%/" 2>nul && echo       OK: vmap4_extractor) || (docker cp %CONTAINER_ID%:/opt/acore/bin/vmap4extractor "%OUTPUT_DIR%/" 2>nul && echo       OK: vmap4extractor) || echo       SKIP: vmap4extractor (nem talalhato)

(docker cp %CONTAINER_ID%:/opt/acore/bin/vmap4_assembler "%OUTPUT_DIR%/" 2>nul && echo       OK: vmap4_assembler) || (docker cp %CONTAINER_ID%:/opt/acore/bin/vmap4assembler "%OUTPUT_DIR%/" 2>nul && echo       OK: vmap4assembler) || echo       SKIP: vmap4assembler (nem talalhato)

(docker cp %CONTAINER_ID%:/opt/acore/bin/mmaps_generator "%OUTPUT_DIR%/" 2>nul && echo       OK: mmaps_generator) || echo       SKIP: mmaps_generator (nem talalhato)

REM Seged-scriptek kimasolasa
copy /y extractor.sh "%OUTPUT_DIR%\" >nul
copy /y extractor.bat "%OUTPUT_DIR%\" >nul
echo       OK: extractor.sh (all-in-one script)
echo       OK: extractor.bat (all-in-one script Windows-hoz)

REM Konteiner torlese
docker rm %CONTAINER_ID% > nul
echo.

REM 3) Eredmeny
echo [2/2] Exportalt fajlok:
dir "%OUTPUT_DIR%"
echo.
echo ==============================================
echo   KESZ! A fajlokat a '%OUTPUT_DIR%' mappaban
echo   talalod. Masold be az osszes fajlt a WoW
echo   kliens mappajaba, majd futtasd az all-in-one
echo   scriptet a kicsomagolashoz:
echo.
echo   - Linux/macOS alatt: ./extractor.sh
echo   - Windows alatt (WSL-ben/Dockerben): extractor.bat
echo.
echo   (A szkriptek automatikusan sorban futtatjak a
echo   map_extractor, vmap4_extractor,
echo   vmap4_assembler es mmaps_generator toolokat.)
echo.
echo   (Megjegyzes: a masolt toolok Linux binarisok,
echo   ezert Windows alatt pl. WSL-ben, dockerben,
echo   vagy Linux rendszeren tudod futtatni oket!)
echo ==============================================
echo.
pause
