#!/bin/bash
# ============================================================
#  AzerothCore Client Data Extractor (All-in-One)
#  Futtasd ezt a scriptet a WoW 3.3.5a kliens főkönyvtárában!
# ============================================================

set -e

# Ellenőrizzük, hogy a WoW.exe vagy Data mappa létezik-e (hogy biztosan a WoW mappában vagyunk-e)
if [ ! -d "Data" ] && [ ! -d "data" ]; then
    echo "HIBA: Úgy tűnik, nem a WoW kliens főkönyvtárában vagy."
    echo "Másold be ezt a scriptet és az exportált toolokat a WoW kliens mellé!"
    exit 1
fi

echo "=============================================="
echo "  AzerothCore All-in-One Extractor"
echo "=============================================="
echo ""

# Megkeressük a toolokat (támogatjuk az aláhúzásos és aláhúzás nélküli neveket is)
MAP_EXTRACTOR="./map_extractor"
if [ ! -f "$MAP_EXTRACTOR" ]; then MAP_EXTRACTOR="./mapextractor"; fi

VMAP_EXTRACTOR="./vmap4_extractor"
if [ ! -f "$VMAP_EXTRACTOR" ]; then VMAP_EXTRACTOR="./vmap4extractor"; fi

VMAP_ASSEMBLER="./vmap4_assembler"
if [ ! -f "$VMAP_ASSEMBLER" ]; then VMAP_ASSEMBLER="./vmap4assembler"; fi

MMAP_GENERATOR="./mmaps_generator"
if [ ! -f "$MMAP_GENERATOR" ]; then MMAP_GENERATOR="./mmaps_generator"; fi

# Ellenőrzés, hogy megvannak-e a binárisok
for bin in "$MAP_EXTRACTOR" "$VMAP_EXTRACTOR" "$VMAP_ASSEMBLER" "$MMAP_GENERATOR"; do
    if [ ! -f "$bin" ]; then
        echo "HIBA: A(z) '$bin' tool nem található ebben a mappában!"
        echo "Kérlek másold ide a kiexportált fájlokat."
        exit 1
    fi
    chmod +x "$bin"
done

echo "[1/4] Térképek kicsomagolása (Maps/DBC)..."
"$MAP_EXTRACTOR"
echo "      ✓ Maps és DBC kicsomagolva!"
echo ""

echo "[2/4] Vmaps kicsomagolása (Vmaps Extractor)..."
"$VMAP_EXTRACTOR"
echo "      ✓ Vmaps kicsomagolva!"
echo ""

echo "[3/4] Vmaps összeállítása (Vmaps Assembler)..."
mkdir -p vmaps
"$VMAP_ASSEMBLER" Buildings vmaps
echo "      ✓ Vmaps összeállítva!"
echo ""

echo "[4/4] Mmaps generálása (Mmaps Generator - ez eltarthat egy ideig)..."
"$MMAP_GENERATOR"
echo "      ✓ Mmaps generálva!"
echo ""

echo "=============================================="
echo "  MINDEN KÉSZ SIKERESEN!"
echo "  A keletkezett 'dbc', 'maps', 'vmaps' és 'mmaps' mappákat"
echo "  másold át a szerver 'configs/data/' könyvtárába."
echo "=============================================="
