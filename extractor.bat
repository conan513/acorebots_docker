@echo off
REM ============================================================
REM  AzerothCore Client Data Extractor (All-in-One - Windows)
REM  Futtasd ezt a scriptet a WoW 3.3.5a kliens főkönyvtárában!
REM ============================================================

if not exist "Data" if not exist "data" (
    echo HIBA: Ugy tunik, nem a WoW kliens fokonyvtaraban vagy.
    echo Masold be ezt a scriptet es az exportalt toolokat a WoW kliens melle!
    pause
    exit /b 1
)

echo ==============================================
echo   AzerothCore All-in-One Extractor (Windows)
echo ==============================================
echo.

REM Kereses: map_extractor / mapextractor
set MAP_EXTRACT_BIN=
if exist map_extractor.exe (set MAP_EXTRACT_BIN=map_extractor.exe) else (
    if exist mapextractor.exe (set MAP_EXTRACT_BIN=mapextractor.exe) else (
        if exist map_extractor (set MAP_EXTRACT_BIN=map_extractor) else (
            if exist mapextractor (set MAP_EXTRACT_BIN=mapextractor)
        )
    )
)

REM Kereses: vmap4_extractor / vmap4extractor
set VMAP_EXTRACT_BIN=
if exist vmap4_extractor.exe (set VMAP_EXTRACT_BIN=vmap4_extractor.exe) else (
    if exist vmap4extractor.exe (set VMAP_EXTRACT_BIN=vmap4extractor.exe) else (
        if exist vmap4_extractor (set VMAP_EXTRACT_BIN=vmap4_extractor) else (
            if exist vmap4extractor (set VMAP_EXTRACT_BIN=vmap4extractor)
        )
    )
)

REM Kereses: vmap4_assembler / vmap4assembler
set VMAP_ASSEM_BIN=
if exist vmap4_assembler.exe (set VMAP_ASSEM_BIN=vmap4_assembler.exe) else (
    if exist vmap4assembler.exe (set VMAP_ASSEM_BIN=vmap4assembler.exe) else (
        if exist vmap4_assembler (set VMAP_ASSEM_BIN=vmap4_assembler) else (
            if exist vmap4assembler (set VMAP_ASSEM_BIN=vmap4assembler)
        )
    )
)

REM Kereses: mmaps_generator
set MMAP_GEN_BIN=
if exist mmaps_generator.exe (set MMAP_GEN_BIN=mmaps_generator.exe) else (
    if exist mmaps_generator (set MMAP_GEN_BIN=mmaps_generator)
)

REM Ellenorzes
if "%MAP_EXTRACT_BIN%"=="" (echo HIBA: map_extractor nem talalhato! & pause & exit /b 1)
if "%VMAP_EXTRACT_BIN%"=="" (echo HIBA: vmap4_extractor nem talalhato! & pause & exit /b 1)
if "%VMAP_ASSEM_BIN%"=="" (echo HIBA: vmap4_assembler nem talalhato! & pause & exit /b 1)
if "%MMAP_GEN_BIN%"=="" (echo HIBA: mmaps_generator nem talalhato! & pause & exit /b 1)

echo [1/4] Terkepek kicsomagolasa (Maps/DBC)...
%MAP_EXTRACT_BIN%
echo       [OK] Maps es DBC kicsomagolva!
echo.

echo [2/4] Vmaps kicsomagolasa (Vmaps Extractor)...
%VMAP_EXTRACT_BIN%
echo       [OK] Vmaps kicsomagolva!
echo.

echo [3/4] Vmaps osszeallitasa (Vmaps Assembler)...
if not exist vmaps mkdir vmaps
%VMAP_ASSEM_BIN% Buildings vmaps
echo       [OK] Vmaps osszeallitva!
echo.

echo [4/4] Mmaps generalasa (Mmaps Generator - ez eltarhat egy ideig)...
%MMAP_GEN_BIN%
echo       [OK] Mmaps generalva!
echo.

echo ==============================================
echo   MINDEN KESZ SIKERESEN!
echo   A keletkezett 'dbc', 'maps', 'vmaps' es 'mmaps' mappakat
echo   masold at a szerver 'configs/data/' konyvtaraba.
echo ==============================================
pause
