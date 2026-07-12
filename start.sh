#!/bin/bash

# Set umask to ensure files created in the container are writeable on the host
umask 000

HOST_CONFIG_DIR="/host-configs"
CONTAINER_CONFIG_DIR="/opt/acore/etc"

echo "[ACORE] Starting MySQL as non-root user..."

# Create MySQL user if it does not exist
id -u mysql &>/dev/null || useradd -r -s /bin/false mysql
chown -R mysql:mysql /opt/acore/data

# Start MySQL as mysql user
su -s /bin/bash mysql -c "mysqld --defaults-file=/etc/mysql/my.cnf" &
sleep 10

echo "[ACORE] Creating Acore MySQL user (if not exists)..."
mysql -uroot -e "CREATE USER IF NOT EXISTS 'acore'@'%' IDENTIFIED BY 'acorepass';"
mysql -uroot -e "GRANT ALL PRIVILEGES ON *.* TO 'acore'@'%'; FLUSH PRIVILEGES;"

echo "[ACORE] Starting config synchronization..."

mkdir -p "$HOST_CONFIG_DIR"
mkdir -p "$HOST_CONFIG_DIR/data"
mkdir -p "$CONTAINER_CONFIG_DIR"

# 1) Copying DIST files to temporary location
cp "$CONTAINER_CONFIG_DIR/authserver.conf.dist" /tmp/auth.dist
cp "$CONTAINER_CONFIG_DIR/worldserver.conf.dist" /tmp/world.dist

# 2) If there is no host config -> copy it
if [ ! -f "$HOST_CONFIG_DIR/authserver.conf" ]; then
    echo "[ACORE] External authserver.conf not found -> copying..."
    cp /tmp/auth.dist "$HOST_CONFIG_DIR/authserver.conf"
fi

if [ ! -f "$HOST_CONFIG_DIR/worldserver.conf" ]; then
    echo "[ACORE] External worldserver.conf not found -> copying..."
    cp /tmp/world.dist "$HOST_CONFIG_DIR/worldserver.conf"
fi

# 3) Compare DIST and HOST -> append missing lines (authserver)
echo "[ACORE] Updating authserver config..."
grep -v '^#' /tmp/auth.dist | while read -r line; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    if ! grep -q "^$key" "$HOST_CONFIG_DIR/authserver.conf"; then
        echo "$line" >> "$HOST_CONFIG_DIR/authserver.conf"
    fi
done

# 3/b) Compare DIST and HOST -> append missing lines (worldserver)
echo "[ACORE] Updating worldserver config..."
grep -v '^#' /tmp/world.dist | while read -r line; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    if ! grep -q "^$key" "$HOST_CONFIG_DIR/worldserver.conf"; then
        echo "$line" >> "$HOST_CONFIG_DIR/worldserver.conf"
    fi
done

# 4) Overwrite database config lines
echo "[ACORE] Configuring DB connection settings..."

sed -i 's/^LoginDatabaseInfo.*/LoginDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_auth"/' "$HOST_CONFIG_DIR/authserver.conf"

sed -i 's/^LoginDatabaseInfo.*/LoginDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_auth"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^WorldDatabaseInfo.*/WorldDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_world"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^CharacterDatabaseInfo.*/CharacterDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_characters"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^DataDir.*/DataDir = "\/host-configs\/data"/' "$HOST_CONFIG_DIR/worldserver.conf"

# 4/b) Performance tuning - worldserver
echo "[ACORE] Applying worldserver performance optimizations..."
sed -i 's/^MapUpdate\.Threads.*/MapUpdate.Threads = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^Network\.Threads.*/Network.Threads = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^LoginDatabase\.WorkerThreads.*/LoginDatabase.WorkerThreads     = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^WorldDatabase\.WorkerThreads.*/WorldDatabase.WorkerThreads     = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^CharacterDatabase\.WorkerThreads.*/CharacterDatabase.WorkerThreads = 4/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^LoginDatabase\.SynchThreads.*/LoginDatabase.SynchThreads     = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^WorldDatabase\.SynchThreads.*/WorldDatabase.SynchThreads     = 2/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^CharacterDatabase\.SynchThreads.*/CharacterDatabase.SynchThreads = 2/' "$HOST_CONFIG_DIR/worldserver.conf"

# 5) Synchronizing Playerbots config
echo "[ACORE] Synchronizing Playerbots config..."

PLAYERBOTS_DIST="/acore/modules/mod-playerbots/conf/playerbots.conf.dist"
PLAYERBOTS_HOST="$HOST_CONFIG_DIR/modules/playerbots.conf"
PLAYERBOTS_CONTAINER="/opt/acore/etc/modules/playerbots.conf"

mkdir -p "$HOST_CONFIG_DIR/modules"
mkdir -p /opt/acore/etc/modules

if [ -f "$PLAYERBOTS_DIST" ]; then
    if [ ! -f "$PLAYERBOTS_HOST" ]; then
        echo "[ACORE] External playerbots.conf not found -> copying..."
        cp "$PLAYERBOTS_DIST" "$PLAYERBOTS_HOST"
    fi

    grep -v '^#' "$PLAYERBOTS_DIST" | while read -r line; do
        [ -z "$line" ] && continue
        key=$(echo "$line" | cut -d= -f1 | xargs)
        if ! grep -q "^$key" "$PLAYERBOTS_HOST"; then
            echo "$line" >> "$PLAYERBOTS_HOST"
        fi
    done

    # Overwrite database config lines in playerbots config
    sed -i 's/^PlayerbotsDatabaseInfo.*/PlayerbotsDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_playerbots"/' "$PLAYERBOTS_HOST"

    # Performance tuning - playerbots
    echo "[ACORE] Applying playerbots performance optimizations..."
    sed -i 's/^AiPlayerbot\.ReactDelay.*/AiPlayerbot.ReactDelay = 200/' "$PLAYERBOTS_HOST"
    sed -i 's/^AiPlayerbot\.IterationsPerTick.*/AiPlayerbot.IterationsPerTick = 5/' "$PLAYERBOTS_HOST"
    sed -i 's/^PlayerbotsDatabase\.WorkerThreads.*/PlayerbotsDatabase.WorkerThreads     = 1/' "$PLAYERBOTS_HOST"
    sed -i 's/^PlayerbotsDatabase\.SynchThreads.*/PlayerbotsDatabase.SynchThreads     = 2/' "$PLAYERBOTS_HOST"

    cp "$PLAYERBOTS_HOST" "$PLAYERBOTS_CONTAINER"
else
    echo "[ACORE] WARNING: playerbots.conf.dist not found in module!"
fi

# 5/b) Synchronizing all other module configs generically
echo "[ACORE] Synchronizing additional module configs..."

if [ -d "/acore/modules" ]; then
    for MODULE_DIR in /acore/modules/*/; do
        MODULE_NAME=$(basename "$MODULE_DIR")

        # Skip playerbots (already handled above)
        if [ "$MODULE_NAME" = "mod-playerbots" ]; then
            continue
        fi

        # Find all .conf.dist files in this module's conf/ directory
        CONF_SUBDIR="$MODULE_DIR/conf"
        if [ ! -d "$CONF_SUBDIR" ]; then
            # Some modules put configs directly in root
            CONF_SUBDIR="$MODULE_DIR"
        fi

        for DIST_FILE in "$CONF_SUBDIR"/*.conf.dist; do
            [ -f "$DIST_FILE" ] || continue  # skip if no match

            CONF_BASENAME=$(basename "$DIST_FILE" .dist)
            HOST_CONF="$HOST_CONFIG_DIR/modules/$CONF_BASENAME"
            CONTAINER_CONF="$CONTAINER_CONFIG_DIR/modules/$CONF_BASENAME"

            if [ ! -f "$HOST_CONF" ]; then
                echo "[ACORE] Module config not found -> copying: $CONF_BASENAME"
                cp "$DIST_FILE" "$HOST_CONF"
            fi

            # Append any missing keys from the dist file
            grep -v '^#' "$DIST_FILE" | while read -r line; do
                [ -z "$line" ] && continue
                key=$(echo "$line" | cut -d= -f1 | xargs)
                if ! grep -q "^$key" "$HOST_CONF"; then
                    echo "$line" >> "$HOST_CONF"
                fi
            done

            # Copy updated config to container path
            cp "$HOST_CONF" "$CONTAINER_CONF"
            echo "[ACORE] Module config synced: $CONF_BASENAME"
        done
    done
fi

# 6) Copy updated configs back to container config directory
cp "$HOST_CONFIG_DIR/authserver.conf" "$CONTAINER_CONFIG_DIR/authserver.conf"
cp "$HOST_CONFIG_DIR/worldserver.conf" "$CONTAINER_CONFIG_DIR/worldserver.conf"

# Ensure all config files and folders on the host are readable/writable by the host user
chmod -R a+rw "$HOST_CONFIG_DIR"

echo "[ACORE] Config synchronization completed."

echo "[ACORE] Starting Web Dashboard (which will control the Auth and World servers)..."
exec node /opt/dashboard/server.js
