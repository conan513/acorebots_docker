#!/bin/bash
# ============================================================
#  AzerothCore Tools Export Script
#  Kimásolja a map/vmap/mmap extractor toolokat a meglévő
#  'acore' docker image-ből a WoW kliens mellé futtatáshoz.
# ============================================================

set -e

OUTPUT_DIR="./wow-tools"
IMAGE_NAME="acore:latest"

echo "=============================================="
echo "  AzerothCore Tools Exporter"
echo "=============================================="
echo ""

# 1) Ellenőrizzük, hogy létezik-e az acore image
if ! docker images -q "$IMAGE_NAME" > /dev/null 2>&1 && ! docker images -q "acore" > /dev/null 2>&1; then
    echo "[!] Az '$IMAGE_NAME' docker image nem található!"
    echo "    Kérlek előbb indítsd el a szerver buildet (pl. ./run-linux.sh vagy az admin felületen),"
    echo "    hogy létrejöjjön a Docker image a beépített toolokkal."
    exit 1
fi

# Megállapítjuk a pontos image nevet (ha van tag, ha nincs)
if docker images -q "$IMAGE_NAME" > /dev/null 2>&1; then
    TARGET_IMAGE="$IMAGE_NAME"
else
    TARGET_IMAGE="acore"
fi

echo "Talált image: $TARGET_IMAGE"
echo ""

# 2) Kimenet mappa létrehozása
mkdir -p "$OUTPUT_DIR"
echo "[1/2] Toolok kimásolása a(z) $TARGET_IMAGE image-ből → $OUTPUT_DIR"

# Ideiglenes konténer indítása csak a másoláshoz
CONTAINER_ID=$(docker create "$TARGET_IMAGE")

# Az összes tool kimásolása csoportok szerint
# Formátum: "kulcs:név1,név2"
TOOLS=(
    "mapextractor:map_extractor,mapextractor"
    "vmap4extractor:vmap4_extractor,vmap4extractor"
    "vmap4assembler:vmap4_assembler,vmap4assembler"
    "mmaps_generator:mmaps_generator"
)

for item in "${TOOLS[@]}"; do
    key="${item%%:*}"
    names_str="${item#*:}"
    IFS=',' read -r -a names <<< "$names_str"
    
    found=false
    for name in "${names[@]}"; do
        if docker cp "$CONTAINER_ID:/opt/acore/bin/$name" "$OUTPUT_DIR/" 2>/dev/null; then
            echo "      ✓ $name"
            found=true
            break
        fi
    done
    if [ "$found" = false ]; then
        echo "      ✗ $key (nem található az image-ben a /opt/acore/bin/ mappában)"
    fi
done

# Segéd-scriptek kimásolása
cp extractor.sh "$OUTPUT_DIR/"
cp extractor.bat "$OUTPUT_DIR/"
chmod +x "$OUTPUT_DIR/extractor.sh"
echo "      ✓ extractor.sh (all-in-one script)"
echo "      ✓ extractor.bat (all-in-one script Windows-hoz)"

# Konténer törlése
docker rm "$CONTAINER_ID" > /dev/null
echo ""

# 3) Összesítés
echo "[2/2] Exportált fájlok:"
ls -lh "$OUTPUT_DIR/"
echo ""
echo "=============================================="
echo "  KÉSZ! A fájlokat a '$OUTPUT_DIR' mappában"
echo "  találod. Másold be az összes fájlt a WoW"
echo "  kliens mappájába, majd futtasd az all-in-one"
echo "  scriptet a kicsomagoláshoz:"
echo ""
echo "  - Linux/macOS alatt: ./extractor.sh"
echo "  - Windows alatt (WSL-ben/Dockerben): extractor.bat"
echo ""
echo "  (A szkriptek automatikusan sorban futtatják a"
echo "  map_extractor, vmap4_extractor,"
echo "  vmap4_assembler és mmaps_generator toolokat.)"
echo "=============================================="
