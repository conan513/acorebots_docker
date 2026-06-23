#!/bin/bash

echo "[ACORE] Checking image..."

if ! docker images | grep -q "^acore "; then
    echo "[ACORE] Image not found, starting build..."
    docker build -t acore .
    if [ $? -ne 0 ]; then
        echo "[ACORE] ERROR: Build failed!"
        exit 1
    fi
else
    echo "[ACORE] Image found, skipping build."
fi

echo "[ACORE] Starting container..."

docker run -it --rm \
    -v "$(pwd)/configs:/host-configs" \
    -v acore-bin:/opt/acore \
    -v acore-source:/acore \
    -p 8085:8085 \
    -p 3724:3724 \
    -p 3310:3310 \
    -p 8000:8000 \
    --cap-add SYS_NICE \
    --cap-add IPC_LOCK \
    --ulimit memlock=-1 \
    acore
