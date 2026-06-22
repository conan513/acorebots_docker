#!/bin/bash

HOST_CONFIG_DIR="/host-configs"
CONTAINER_CONFIG_DIR="/opt/acore/etc"

echo "[ACORE] MySQL indítása nem-root userként..."

# MySQL user létrehozása, ha nem létezik
id -u mysql &>/dev/null || useradd -r -s /bin/false mysql
chown -R mysql:mysql /opt/acore/data

# MySQL indítása mysql userként
su -s /bin/bash mysql -c "mysqld --defaults-file=/etc/mysql/my.cnf" &
sleep 10

echo "[ACORE] Acore MySQL user létrehozása (ha még nincs)..."
mysql -uroot -e "CREATE USER IF NOT EXISTS 'acore'@'%' IDENTIFIED BY 'acorepass';"
mysql -uroot -e "GRANT ALL PRIVILEGES ON *.* TO 'acore'@'%'; FLUSH PRIVILEGES;"

echo "[ACORE] Config szinkronizálás indul..."

mkdir -p "$HOST_CONFIG_DIR"
mkdir -p "$HOST_CONFIG_DIR/data"
mkdir -p "$CONTAINER_CONFIG_DIR"

# 1) DIST fájlok másolása ideiglenes helyre
cp "$CONTAINER_CONFIG_DIR/authserver.conf.dist" /tmp/auth.dist
cp "$CONTAINER_CONFIG_DIR/worldserver.conf.dist" /tmp/world.dist

# 2) Ha nincs host config → kimásoljuk
if [ ! -f "$HOST_CONFIG_DIR/authserver.conf" ]; then
    echo "[ACORE] Nincs külső authserver.conf → másolás..."
    cp /tmp/auth.dist "$HOST_CONFIG_DIR/authserver.conf"
fi

if [ ! -f "$HOST_CONFIG_DIR/worldserver.conf" ]; then
    echo "[ACORE] Nincs külső worldserver.conf → másolás..."
    cp /tmp/world.dist "$HOST_CONFIG_DIR/worldserver.conf"
fi

# 3) DIST és HOST összevetése → hiányzó sorok pótlása (authserver)
echo "[ACORE] Authserver config frissítése..."
grep -v '^#' /tmp/auth.dist | while read -r line; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    if ! grep -q "^$key" "$HOST_CONFIG_DIR/authserver.conf"; then
        echo "$line" >> "$HOST_CONFIG_DIR/authserver.conf"
    fi
done

# 3/b) DIST és HOST összevetése → hiányzó sorok pótlása (worldserver)
echo "[ACORE] Worldserver config frissítése..."
grep -v '^#' /tmp/world.dist | while read -r line; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -d= -f1 | xargs)
    if ! grep -q "^$key" "$HOST_CONFIG_DIR/worldserver.conf"; then
        echo "$line" >> "$HOST_CONFIG_DIR/worldserver.conf"
    fi
done

# 4) DB sorok felülírása
echo "[ACORE] DB sorok beállítása..."

sed -i 's/^LoginDatabaseInfo.*/LoginDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_auth"/' "$HOST_CONFIG_DIR/authserver.conf"

sed -i 's/^LoginDatabaseInfo.*/LoginDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_auth"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^WorldDatabaseInfo.*/WorldDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_world"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^CharacterDatabaseInfo.*/CharacterDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_characters"/' "$HOST_CONFIG_DIR/worldserver.conf"
sed -i 's/^DataDir.*/DataDir = "\/host-configs\/data"/' "$HOST_CONFIG_DIR/worldserver.conf"

# 5) Playerbots config szinkronizálása
echo "[ACORE] Playerbots config szinkronizálása..."

PLAYERBOTS_DIST="/acore/modules/mod-playerbots/conf/playerbots.conf.dist"
PLAYERBOTS_HOST="$HOST_CONFIG_DIR/modules/playerbots.conf"
PLAYERBOTS_CONTAINER="/opt/acore/etc/modules/playerbots.conf"

mkdir -p "$HOST_CONFIG_DIR/modules"
mkdir -p /opt/acore/etc/modules

if [ -f "$PLAYERBOTS_DIST" ]; then
    if [ ! -f "$PLAYERBOTS_HOST" ]; then
        echo "[ACORE] Nincs külső playerbots.conf → másolás..."
        cp "$PLAYERBOTS_DIST" "$PLAYERBOTS_HOST"
    fi

    grep -v '^#' "$PLAYERBOTS_DIST" | while read -r line; do
        [ -z "$line" ] && continue
        key=$(echo "$line" | cut -d= -f1 | xargs)
        if ! grep -q "^$key" "$PLAYERBOTS_HOST"; then
            echo "$line" >> "$PLAYERBOTS_HOST"
        fi
    done

    # DB sorok felülírása a playerbots configban
    sed -i 's/^PlayerbotsDatabaseInfo.*/PlayerbotsDatabaseInfo = "127.0.0.1;3310;acore;acorepass;acore_playerbots"/' "$PLAYERBOTS_HOST"

    cp "$PLAYERBOTS_HOST" "$PLAYERBOTS_CONTAINER"
else
    echo "[ACORE] FIGYELEM: Nem található playerbots.conf.dist a modulban!"
fi

# 6) Frissített configok visszamásolása a konténer config mappájába
cp "$HOST_CONFIG_DIR/authserver.conf" "$CONTAINER_CONFIG_DIR/authserver.conf"
cp "$HOST_CONFIG_DIR/worldserver.conf" "$CONTAINER_CONFIG_DIR/worldserver.conf"

echo "[ACORE] Config szinkronizálás kész."

echo "[ACORE] Webes vezérlőpult indítása (ez irányítja majd az Auth és World szervereket)..."
exec node /opt/dashboard/server.js
