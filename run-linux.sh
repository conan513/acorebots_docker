#!/bin/bash

echo "[ACORE] Image ellenőrzése..."

if ! docker images | grep -q "^acore "; then
    echo "[ACORE] Image nem található, build indul..."
    docker build -t acore .
    if [ $? -ne 0 ]; then
        echo "[ACORE] HIBA: A build sikertelen volt!"
        exit 1
    fi
else
    echo "[ACORE] Image megtalálva, build kihagyva."
fi

echo "[ACORE] Konténer indítása..."

docker run -it --rm \
    -v "$(pwd)/configs:/host-configs" \
    -p 8085:8085 \
    -p 3724:3724 \
    -p 3310:3310 \
    acore
