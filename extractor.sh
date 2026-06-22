#!/bin/bash
# ============================================================
#  AzerothCore Client Data Extractor (All-in-One)
#  Docker-en belül futtatja a toolokat – nem kell semmi
#  dependency a host gépre!
# ============================================================

set -e

IMAGE_NAME="acore:latest"

echo "=============================================="
echo "  AzerothCore All-in-One Extractor"
echo "  (Docker-en belül futtatva)"
echo "=============================================="
echo ""

# --- WoW mappa bekérése ---
while true; do
    read -rp "  Add meg a WoW 3.3.5a kliens mappájának teljes útvonalát: " WOW_DIR
    # Tilde feloldása
    WOW_DIR="${WOW_DIR/#\~/$HOME}"
    # Záró perjel eltávolítása
    WOW_DIR="${WOW_DIR%/}"

    if [ -d "$WOW_DIR/Data" ] || [ -d "$WOW_DIR/data" ]; then
        echo "  ✓ WoW mappa megtalálva: $WOW_DIR"
        break
    else
        echo "  ✗ HIBA: A megadott mappában nem található 'Data' almappa."
        echo "    Győződj meg róla, hogy a WoW kliens főkönyvtárát adtad meg!"
        echo ""
    fi
done
echo ""

# --- Ellenőrzések ---


if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
    # Próbáljuk tag nélkül is
    if ! docker image inspect "acore" > /dev/null 2>&1; then
        echo "HIBA: Az '$IMAGE_NAME' Docker image nem található!"
        echo "  Kérlek előbb buildeld fel a szervert (./run-linux.sh vagy az admin felületen)."
        exit 1
    fi
    IMAGE_NAME="acore"
fi

# --- Ellenőrizzük, hogy a toolok benne vannak-e az image-ben ---
echo "  Toolok ellenőrzése az image-ben..."
MISSING_TOOLS=()
for tool in map_extractor vmap4_extractor vmap4_assembler mmaps_generator; do
    if ! docker run --rm "$IMAGE_NAME" test -f "/opt/acore/bin/$tool" 2>/dev/null; then
        MISSING_TOOLS+=("$tool")
    fi
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo ""
    echo "HIBA: A következő toolok hiányoznak a Docker image-ből:"
    for t in "${MISSING_TOOLS[@]}"; do
        echo "  ✗ /opt/acore/bin/$t"
    done
    echo ""
    echo "  Lehetséges okok:"
    echo "    - A szerver build még nem fejeződött be"
    echo "    - A build hibával állt le (ellenőrizd a logokat)"
    echo "    - Az image nem az 'acore' projekt image-e"
    echo ""
    echo "  Megoldás: futtasd újra a buildet (./run-linux.sh vagy az admin felületen),"
    echo "  várj amíg teljesen elkészül, majd futtasd újra ezt a scriptet."
    exit 1
fi
echo "  ✓ Minden tool elérhető az image-ben."
echo ""

echo "  WoW mappa : $WOW_DIR"
echo "  Image     : $IMAGE_NAME"
echo ""

# --- Célmappa előkészítése ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/configs/data"
mkdir -p "$DATA_DIR"

echo "  Cél adat mappa: $DATA_DIR"
echo ""

# --- Korábbi extrakció takarítása ---
echo "  [Előkészítés] Régi extrakciós mappák törlése a WoW mappából..."

# User-owned mappák (sudo nélkül)
for dir in dbc maps cameras; do
    if [ -d "$WOW_DIR/$dir" ]; then
        rm -rf "${WOW_DIR:?}/$dir"
        echo "    ✓ $dir törölve"
    fi
done

# Root-owned mappák (Docker hozta létre korábban, sudo kell)
ROOT_DIRS=()
for dir in Buildings vmaps mmaps; do
    if [ -d "$WOW_DIR/$dir" ]; then
        ROOT_DIRS+=("${WOW_DIR:?}/$dir")
    fi
done

if [ ${#ROOT_DIRS[@]} -gt 0 ]; then
    echo "    Root-owned mappák törléséhez jelszó szükséges:"
    sudo rm -rf "${ROOT_DIRS[@]}"
    for dir in Buildings vmaps mmaps; do
        [ -d "$WOW_DIR/$dir" ] || echo "    ✓ $dir törölve"
    done
fi

echo "  ✓ Tiszta állapot."
echo ""


echo "[1/4] Maps + DBC kicsomagolása..."
echo "[2/4] Vmaps kicsomagolása..."
echo "[3/4] Vmaps összeállítása..."
echo "[4/4] Mmaps generálása (ez eltarthat akár órákat is!)..."
echo ""
echo "----------------------------------------------"

docker run --rm \
    -v "$WOW_DIR:/wow" \
    -v "$DATA_DIR:/data" \
    "$IMAGE_NAME" \
    bash -c '
        set -e

        # Ideiglenes, teljesen tiszta munkakönyvtár a konténeren belül
        WORKDIR=$(mktemp -d /tmp/acore_extract.XXXXXX)
        echo "  Munkakönyvtár: $WORKDIR"

        # A WoW Data/ mappa linkelése a munkakönyvtárba
        ln -s /wow/Data "$WORKDIR/Data"
        cd "$WORKDIR"

        echo ""
        echo "[1/4] Maps + DBC kicsomagolása (map_extractor)..."
        /opt/acore/bin/map_extractor
        echo "      ✓ Maps és DBC kicsomagolva!"
        echo ""

        echo "[2/4] Vmaps kicsomagolása (vmap4_extractor)..."
        /opt/acore/bin/vmap4_extractor
        echo "      ✓ Vmaps kicsomagolva!"
        echo ""

        echo "[3/4] Vmaps összeállítása (vmap4_assembler)..."
        mkdir -p vmaps
        /opt/acore/bin/vmap4_assembler Buildings vmaps
        echo "      ✓ Vmaps összeállítva!"
        echo ""

        echo "[4/4] Mmaps generálása (mmaps_generator)..."
        mkdir -p mmaps
        /opt/acore/bin/mmaps_generator
        echo "      ✓ Mmaps generálva!"
        echo ""

        echo "[5/5] Adatok áthelyezése a szerver mappájába..."
        for folder in dbc maps vmaps mmaps; do
            if [ -d "$WORKDIR/$folder" ]; then
                rm -rf "/data/$folder"
                mv "$WORKDIR/$folder" "/data/$folder"
                echo "      ✓ $folder → /data/$folder"
            else
                echo "      ✗ FIGYELEM: $folder nem jött létre!"
            fi
        done

        echo ""
        echo "  Ideiglenes mappa takarítása..."
        rm -rf "$WORKDIR"
        echo "  ✓ Kész."
    '

echo "----------------------------------------------"
echo ""

# Tulajdonos visszaállítása a jelenlegi userre (Docker root-ként hozta létre)
echo "  Jogosultságok visszaállítása..."
sudo chown -R "$USER:" "$DATA_DIR"
echo "  ✓ Kész."

echo ""
echo "=============================================="
echo "  MINDEN KÉSZ ÉS HELYÉRE RAKVA!"
echo ""
echo "  A szerver adatai itt találhatók:"
echo "    $DATA_DIR"
echo "=============================================="
