#!/bin/bash
# ============================================================
#  AzerothCore Client Data Extractor (All-in-One)
#  Runs the tools inside Docker – no need for any
#  dependency on the host machine!
# ============================================================

set -e

IMAGE_NAME="acore:latest"

echo "=============================================="
echo "  AzerothCore All-in-One Extractor"
echo "  (Running inside Docker)"
echo "=============================================="
echo ""

# --- Prompt for WoW folder ---
while true; do
    read -rp "  Enter the full path to your WoW 3.3.5a client folder: " WOW_DIR
    # Resolve tilde
    WOW_DIR="${WOW_DIR/#\~/$HOME}"
    # Remove trailing slash
    WOW_DIR="${WOW_DIR%/}"

    if [ -d "$WOW_DIR/Data" ] || [ -d "$WOW_DIR/data" ]; then
        echo "  ✓ WoW folder found: $WOW_DIR"
        break
    else
        echo "  ✗ ERROR: The specified folder does not contain a 'Data' subfolder."
        echo "    Make sure you entered the WoW client root directory!"
        echo ""
    fi
done
echo ""

# --- Checks ---


if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
    # Try without tag as well
    if ! docker image inspect "acore" > /dev/null 2>&1; then
        echo "ERROR: The '$IMAGE_NAME' Docker image was not found!"
        echo "  Please build the server first (./run-linux.sh or in the administration panel)."
        exit 1
    fi
    IMAGE_NAME="acore"
fi

# --- Verify that tools are present in the image ---
echo "  Verifying tools in the image..."
MISSING_TOOLS=()
for tool in map_extractor vmap4_extractor vmap4_assembler mmaps_generator; do
    if ! docker run --rm "$IMAGE_NAME" test -f "/opt/acore/bin/$tool" 2>/dev/null; then
        MISSING_TOOLS+=("$tool")
    fi
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo ""
    echo "ERROR: The following tools are missing from the Docker image:"
    for t in "${MISSING_TOOLS[@]}"; do
        echo "  ✗ /opt/acore/bin/$t"
    done
    echo ""
    echo "  Possible reasons:"
    echo "    - The server build is not finished yet"
    echo "    - The build failed (check the logs)"
    echo "    - The image is not the 'acore' project image"
    echo ""
    echo "  Solution: run the build again (./run-linux.sh or in the administration panel),"
    echo "  wait until it finishes completely, and then rerun this script."
    exit 1
fi
echo "  ✓ All tools are available in the image."
echo ""

echo "  WoW folder : $WOW_DIR"
echo "  Image      : $IMAGE_NAME"
echo ""

# --- Prepare target folder ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/configs/data"
mkdir -p "$DATA_DIR"

echo "  Target data folder: $DATA_DIR"
echo ""

# --- Clean up previous extraction ---
echo "  [Preparation] Deleting old extraction folders from the WoW folder..."

# User-owned folders (without sudo)
for dir in dbc maps cameras; do
    if [ -d "$WOW_DIR/$dir" ]; then
        rm -rf "${WOW_DIR:?}/$dir"
        echo "    ✓ $dir deleted"
    fi
done

# Root-owned folders (created by Docker earlier, requires sudo)
ROOT_DIRS=()
for dir in Buildings vmaps mmaps; do
    if [ -d "$WOW_DIR/$dir" ]; then
        ROOT_DIRS+=("${WOW_DIR:?}/$dir")
    fi
done

if [ ${#ROOT_DIRS[@]} -gt 0 ]; then
    echo "    Password required to delete root-owned folders:"
    sudo rm -rf "${ROOT_DIRS[@]}"
    for dir in Buildings vmaps mmaps; do
        [ -d "$WOW_DIR/$dir" ] || echo "    ✓ $dir deleted"
    done
fi

echo "  ✓ Clean state."
echo ""


echo "[1/4] Extracting Maps + DBC..."
echo "[2/4] Extracting Vmaps..."
echo "[3/4] Assembling Vmaps..."
echo "[4/4] Generating Mmaps (this can take hours!)..."
echo ""
echo "----------------------------------------------"

docker run --rm \
    -v "$WOW_DIR:/wow" \
    -v "$DATA_DIR:/data" \
    "$IMAGE_NAME" \
    bash -c '
        set -e

        # Clean temporary working directory inside the container
        WORKDIR=$(mktemp -d /tmp/acore_extract.XXXXXX)
        echo "  Working directory: $WORKDIR"

        # Link WoW Data/ folder to working directory
        ln -s /wow/Data "$WORKDIR/Data"
        cd "$WORKDIR"

        echo ""
        echo "[1/4] Extracting Maps + DBC (map_extractor)..."
        /opt/acore/bin/map_extractor
        echo "      ✓ Maps and DBC extracted!"
        echo ""

        echo "[2/4] Extracting Vmaps (vmap4_extractor)..."
        /opt/acore/bin/vmap4_extractor
        echo "      ✓ Vmaps extracted!"
        echo ""

        echo "[3/4] Assembling Vmaps (vmap4_assembler)..."
        mkdir -p vmaps
        /opt/acore/bin/vmap4_assembler Buildings vmaps
        echo "      ✓ Vmaps assembled!"
        echo ""

        echo "[4/4] Generating Mmaps (mmaps_generator)..."
        mkdir -p mmaps
        /opt/acore/bin/mmaps_generator
        echo "      ✓ Mmaps generated!"
        echo ""

        echo "[5/5] Moving data to server directory..."
        for folder in dbc maps vmaps mmaps; do
            if [ -d "$WORKDIR/$folder" ]; then
                rm -rf "/data/$folder"
                mv "$WORKDIR/$folder" "/data/$folder"
                echo "      ✓ $folder → /data/$folder"
            else
                echo "      ✗ WARNING: $folder was not created!"
            fi
        done

        echo ""
        echo "  Cleaning up temporary folder..."
        rm -rf "$WORKDIR"
        echo "  ✓ Done."
    '

echo "----------------------------------------------"
echo ""

# Restore permissions to current user
echo "  Restoring permissions..."
sudo chown -R "$USER:" "$DATA_DIR"
echo "  ✓ Done."

echo ""
echo "=============================================="
echo "  ALL DONE AND IN PLACE!"
echo ""
echo "  Server data can be found here:"
echo "    $DATA_DIR"
echo "=============================================="
