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

echo "[ACORE] Creating Acore MySQL user and databases (if not exists)..."
mysql -uroot -e "CREATE USER IF NOT EXISTS 'acore'@'%' IDENTIFIED BY 'acorepass';"
mysql -uroot -e "GRANT ALL PRIVILEGES ON *.* TO 'acore'@'%'; FLUSH PRIVILEGES;"
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS acore_characters DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS acore_world DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS acore_auth DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS acore_playerbots DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

mkdir -p "$HOST_CONFIG_DIR"
IMPORT_LOG="$HOST_CONFIG_DIR/.imported_base_sqls"
touch "$IMPORT_LOG"

echo "[ACORE] Automatically fixing known module SQL bugs..."
if [ -d "/acore/modules/mod-dungeon-master" ]; then
    find /acore/modules/mod-dungeon-master -name "*.sql" -type f | while read -r sql_file; do
        if grep -q "id1" "$sql_file"; then
            echo "[ACORE] Fixing id1 column typo in: $(basename "$sql_file")"
            sed -i 's/`id1`/`id`/g' "$sql_file"
            sed -i 's/\bid1\b/id/g' "$sql_file"
        fi
    done
fi

echo "[ACORE] Automatically importing module base SQL files (only once)..."
if [ -d "/acore/modules" ]; then
    for MODULE_DIR in /acore/modules/*/; do
        [ -d "$MODULE_DIR" ] || continue
        MODULE_NAME=$(basename "$MODULE_DIR")

        # Skip playerbots (handled by the server core)
        if [ "$MODULE_NAME" = "mod-playerbots" ]; then
            continue
        fi
        
        # 1) db-characters / characters base SQLs
        CHAR_BASE_DIR="$MODULE_DIR/data/sql/db-characters/base"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/sql/db-characters/base"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/data/sql/db-characters"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/sql/db-characters"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/data/sql/characters/base"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/sql/characters/base"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/data/sql/characters"
        [ -d "$CHAR_BASE_DIR" ] || CHAR_BASE_DIR="$MODULE_DIR/sql/characters"
        
        if [ -d "$CHAR_BASE_DIR" ]; then
            for SQL_FILE in "$CHAR_BASE_DIR"/*.sql; do
                [ -f "$SQL_FILE" ] || continue
                SQL_IDENTIFIER="$MODULE_NAME/db-characters/$(basename "$SQL_FILE")"
                if grep -qF "$SQL_IDENTIFIER" "$IMPORT_LOG"; then
                    echo "[ACORE] Base SQL already imported, skipping: $SQL_IDENTIFIER"
                else
                    echo "[ACORE] Importing base SQL into acore_characters: $(basename "$SQL_FILE")"
                    if mysql -uroot acore_characters < "$SQL_FILE"; then
                        echo "$SQL_IDENTIFIER" >> "$IMPORT_LOG"
                    fi
                fi
            done
        fi

        # 2) db-world / world base SQLs
        WORLD_BASE_DIR="$MODULE_DIR/data/sql/db-world/base"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/sql/db-world/base"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/data/sql/db-world"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/sql/db-world"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/data/sql/world/base"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/sql/world/base"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/data/sql/world"
        [ -d "$WORLD_BASE_DIR" ] || WORLD_BASE_DIR="$MODULE_DIR/sql/world"

        if [ -d "$WORLD_BASE_DIR" ]; then
            for SQL_FILE in "$WORLD_BASE_DIR"/*.sql; do
                [ -f "$SQL_FILE" ] || continue
                SQL_IDENTIFIER="$MODULE_NAME/db-world/$(basename "$SQL_FILE")"
                if grep -qF "$SQL_IDENTIFIER" "$IMPORT_LOG"; then
                    echo "[ACORE] Base SQL already imported, skipping: $SQL_IDENTIFIER"
                else
                    echo "[ACORE] Importing base SQL into acore_world: $(basename "$SQL_FILE")"
                    if mysql -uroot acore_world < "$SQL_FILE"; then
                        echo "$SQL_IDENTIFIER" >> "$IMPORT_LOG"
                    fi
                fi
            done
        fi

        # 3) db-auth / auth base SQLs
        AUTH_BASE_DIR="$MODULE_DIR/data/sql/db-auth/base"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/sql/db-auth/base"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/data/sql/db-auth"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/sql/db-auth"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/data/sql/auth/base"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/sql/auth/base"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/data/sql/auth"
        [ -d "$AUTH_BASE_DIR" ] || AUTH_BASE_DIR="$MODULE_DIR/sql/auth"

        if [ -d "$AUTH_BASE_DIR" ]; then
            for SQL_FILE in "$AUTH_BASE_DIR"/*.sql; do
                [ -f "$SQL_FILE" ] || continue
                SQL_IDENTIFIER="$MODULE_NAME/db-auth/$(basename "$SQL_FILE")"
                if grep -qF "$SQL_IDENTIFIER" "$IMPORT_LOG"; then
                    echo "[ACORE] Base SQL already imported, skipping: $SQL_IDENTIFIER"
                else
                    echo "[ACORE] Importing base SQL into acore_auth: $(basename "$SQL_FILE")"
                    if mysql -uroot acore_auth < "$SQL_FILE"; then
                        echo "$SQL_IDENTIFIER" >> "$IMPORT_LOG"
                    fi
                fi
            done
        fi

        # 4) playerbots base SQLs
        PB_BASE_DIR="$MODULE_DIR/data/sql/playerbots/base"
        [ -d "$PB_BASE_DIR" ] || PB_BASE_DIR="$MODULE_DIR/sql/playerbots/base"
        [ -d "$PB_BASE_DIR" ] || PB_BASE_DIR="$MODULE_DIR/data/sql/playerbots"
        [ -d "$PB_BASE_DIR" ] || PB_BASE_DIR="$MODULE_DIR/sql/playerbots"

        if [ -d "$PB_BASE_DIR" ]; then
            for SQL_FILE in "$PB_BASE_DIR"/*.sql; do
                [ -f "$SQL_FILE" ] || continue
                SQL_IDENTIFIER="$MODULE_NAME/playerbots/$(basename "$SQL_FILE")"
                if grep -qF "$SQL_IDENTIFIER" "$IMPORT_LOG"; then
                    echo "[ACORE] Base SQL already imported, skipping: $SQL_IDENTIFIER"
                else
                    echo "[ACORE] Importing base SQL into acore_playerbots: $(basename "$SQL_FILE")"
                    if mysql -uroot acore_playerbots < "$SQL_FILE"; then
                        echo "$SQL_IDENTIFIER" >> "$IMPORT_LOG"
                    fi
                fi
            done
        fi
    done
fi

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
    [[ "$line" == *=* ]] || continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    escaped_key="${key//./\\.}"
    if ! grep -q "^$escaped_key" "$HOST_CONFIG_DIR/authserver.conf"; then
        echo "$line" >> "$HOST_CONFIG_DIR/authserver.conf"
    fi
done

# 3/b) Compare DIST and HOST -> append missing lines (worldserver)
echo "[ACORE] Updating worldserver config..."
grep -v '^#' /tmp/world.dist | while read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" == *=* ]] || continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    escaped_key="${key//./\\.}"
    if ! grep -q "^$escaped_key" "$HOST_CONFIG_DIR/worldserver.conf"; then
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
        [[ "$line" == *=* ]] || continue
        key=$(echo "$line" | cut -d= -f1 | xargs)
        escaped_key="${key//./\\.}"
        if ! grep -q "^$escaped_key" "$PLAYERBOTS_HOST"; then
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
                [[ "$line" == *=* ]] || continue
                key=$(echo "$line" | cut -d= -f1 | xargs)
                escaped_key="${key//./\\.}"
                if ! grep -q "^$escaped_key" "$HOST_CONF"; then
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
# Reset umask to standard 022 so that temporary files (like mysql config files) are not world-writable
umask 022
exec node /opt/dashboard/server.js
