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

if [ -z "$REALM_IP" ]; then
    # Try to get the IP address of the default route interface
    REALM_IP=$(ipconfig getifaddr $(route get default 2>/dev/null | awk '/interface:/ {print $2}') 2>/dev/null)
    # Fallback to ifconfig
    if [ -z "$REALM_IP" ]; then
        REALM_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n 1)
    fi
fi

if [ -z "$REALM_IP" ]; then
    REALM_IP="127.0.0.1"
fi

echo "[ACORE] Detected Host LAN IP: $REALM_IP"
echo "[ACORE] Starting container..."

docker run -it --rm \
    --name acore-server \
    -e REALM_IP="$REALM_IP" \
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
