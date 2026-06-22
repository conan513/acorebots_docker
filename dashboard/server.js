const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

const PORT = 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_CONFIG_FILE = '/host-configs/modules.json';
const PASSWORD_FILE = '/host-configs/admin_password.txt';

// Globális session tároló
const activeSessions = new Set();

// Szerver folyamatok referenciái
let authProcess = null;
let worldProcess = null;

let authState = 'stopped'; // stopped, starting, running
let worldState = 'stopped'; // stopped, starting, running
let rebuildStatus = 'idle'; // idle, building

let authPid = null;
let worldPid = null;
let mysqlPid = null;

// Log history puffer (utolsó 200 sor)
const maxLogHistory = 200;
const logHistory = [];

// SSE kliensek listája
let sseClients = [];

// Aktív játékosok száma ( worldserver .server info parancsból nyerhető ki, vagy alapértelmezetten 0 )
let activePlayerCount = 0;
let worldUptime = 0; // másodpercben
let worldStartTime = null;

// ==========================================================================
// Segédfüggvények
// ==========================================================================

function addLog(service, text) {
    // Sorbeli tisztítás (pl. színes ANSI kódok eltávolítása, ha vannak)
    const cleanedText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
    if (!cleanedText) return;

    const logEntry = {
        time: new Date().toLocaleTimeString('hu-HU'),
        service, // 'world', 'auth', 'system', 'input'
        text: cleanedText
    };

    logHistory.push(logEntry);
    if (logHistory.length > maxLogHistory) {
        logHistory.shift();
    }

    // Küldés az aktív SSE klienseknek
    broadcastToSse('log', logEntry);
}

function addSystemLog(text) {
    addLog('system', text);
    console.log(`[SYSTEM] ${text}`);
}

function broadcastToSse(eventType, data) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        client.write(message);
    });
}

// Cookie parszolás
function parseCookies(request) {
    const list = {};
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });

    return list;
}

// ==========================================================================
// Szerver Folyamatok Kezelése (Spawn & Monitor)
// ==========================================================================

// MySQL PID lekérdezése
function updateMysqlPid() {
    return new Promise((resolve) => {
        exec('pgrep mysqld', (err, stdout) => {
            if (err || !stdout) {
                mysqlPid = null;
            } else {
                mysqlPid = parseInt(stdout.trim()) || null;
            }
            resolve(mysqlPid);
        });
    });
}

// CPU/RAM adatok lekérdezése egy PID-hez
function getProcessStats(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve({ cpu: 0, ram: 0 });
        exec(`ps -p ${pid} -o %cpu,rss --no-headers`, (err, stdout) => {
            if (err || !stdout) {
                return resolve({ cpu: 0, ram: 0 });
            }
            const parts = stdout.trim().split(/\s+/);
            if (parts.length >= 2) {
                const cpu = parseFloat(parts[0]) || 0;
                const rssKb = parseInt(parts[1]) || 0;
                const ramMb = Math.round(rssKb / 1024);
                resolve({ cpu, ram: ramMb });
            } else {
                resolve({ cpu: 0, ram: 0 });
            }
        });
    });
}

// Rendszeres statisztika frissítés és küldés
async function sendStatsUpdate() {
    await updateMysqlPid();
    
    const mysqlStats = mysqlPid ? await getProcessStats(mysqlPid) : { cpu: 0, ram: 0 };
    const authStats = authPid ? await getProcessStats(authPid) : { cpu: 0, ram: 0 };
    const worldStats = worldPid ? await getProcessStats(worldPid) : { cpu: 0, ram: 0 };

    // Uptime számítása, ha a worldserver fut
    if (worldState === 'running' && worldStartTime) {
        worldUptime = Math.round((Date.now() - worldStartTime) / 1000);
    } else {
        worldUptime = 0;
    }

    const payload = {
        mysql: {
            status: mysqlPid ? 'running' : 'offline',
            cpu: mysqlStats.cpu,
            ram: mysqlStats.ram
        },
        authserver: {
            status: authState,
            cpu: authStats.cpu,
            ram: authStats.ram
        },
        worldserver: {
            status: worldState,
            cpu: worldStats.cpu,
            ram: worldStats.ram,
            uptime: worldUptime
        },
        playerCount: activePlayerCount,
        rebuildStatus: rebuildStatus
    };

    broadcastToSse('stats', payload);
}

// Folyamat adatok stream feldolgozása soronként
function handleProcessOutput(process, name) {
    let buffer = '';
    process.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // utolsó befejezetlen sor visszarakása a pufferbe
        
        lines.forEach(line => {
            addLog(name, line);
            
            // Automatikus "yes" válasz küldése adatbázis és frissítési kérdésekre
            if (name === 'world' && (line.includes('[yes (default) / no]:') || line.includes('Do you want to create it?') || line.includes('Do you want to apply'))) {
                addSystemLog('Adatbázis/frissítés jóváhagyási kérdés észlelve a Worldservertől. Automatikus válasz: yes');
                process.stdin.write('yes\n');
            }
            
            // Worldserver indítási fázisának figyelése
            if (name === 'world' && worldState === 'starting') {
                if (line.includes('World daemon-thread running') || line.includes('ready') || line.includes('max connections')) {
                    worldState = 'running';
                    worldStartTime = Date.now();
                    addSystemLog('Worldserver sikeresen elindult, játékra kész!');
                }
            }

            // Aktív játékosok számának kinyerése a naplóból (pl. ha a server info lefut)
            // AzerothCore formátum: "Players online: X (max: Y)" vagy hasonló bot statok
            if (name === 'world') {
                const match = line.match(/Players online:\s*(\d+)/i) || line.match(/játékos online:\s*(\d+)/i);
                if (match) {
                    activePlayerCount = parseInt(match[1]);
                }
            }
        });
    });

    process.stderr.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if (line.trim()) {
                addLog(name, `[ERR] ${line}`);
            }
        });
    });
}

function startAuthserver() {
    if (authState !== 'stopped') return;
    authState = 'starting';
    addSystemLog('Authserver indítása...');

    try {
        authProcess = spawn('/opt/acore/bin/authserver', [], {
            cwd: '/opt/acore/bin',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        authPid = authProcess.pid;
        authState = 'running';
        addSystemLog(`Authserver elindult (PID: ${authPid})`);

        handleProcessOutput(authProcess, 'auth');

        authProcess.on('exit', (code) => {
            addSystemLog(`Authserver leállt. Exit code: ${code}`);
            authState = 'stopped';
            authPid = null;
            authProcess = null;
        });
    } catch (err) {
        addSystemLog(`Hiba az Authserver indításakor: ${err.message}`);
        authState = 'stopped';
        authPid = null;
    }
}

function startWorldserver() {
    if (worldState !== 'stopped') return;
    worldState = 'starting';
    addSystemLog('Worldserver indítása...');

    try {
        worldProcess = spawn('/opt/acore/bin/worldserver', [], {
            cwd: '/opt/acore/bin',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        worldPid = worldProcess.pid;
        addSystemLog(`Worldserver folyamat elindítva (PID: ${worldPid}). Adatbázisok betöltése folyamatban...`);

        handleProcessOutput(worldProcess, 'world');

        worldProcess.on('exit', (code) => {
            addSystemLog(`Worldserver leállt. Exit code: ${code}`);
            worldState = 'stopped';
            worldPid = null;
            worldProcess = null;
            worldStartTime = null;
            activePlayerCount = 0;
        });
    } catch (err) {
        addSystemLog(`Hiba a Worldserver indításakor: ${err.message}`);
        worldState = 'stopped';
        worldPid = null;
    }
}

function stopAuthserver() {
    if (authState === 'stopped' || !authProcess) return;
    addSystemLog('Authserver leállítása (SIGINT)...');
    authProcess.kill('SIGINT');
}

function stopWorldserver() {
    if (worldState === 'stopped' || !worldProcess) return;
    addSystemLog('Worldserver leállítása (graceful shutdown parancs elküldése)...');
    
    // Tiszta leállítás a WoW konzolon keresztül
    worldProcess.stdin.write('shutdown 0\n');

    // Biztonsági timeout: ha 15 mp múlva sem áll le, leöljük
    const forceKillTimeout = setTimeout(() => {
        if (worldProcess) {
            addSystemLog('Worldserver nem állt le időben. Folyamat kényszerített leállítása (SIGKILL)...');
            worldProcess.kill('SIGKILL');
        }
    }, 15000);

    worldProcess.once('exit', () => {
        clearTimeout(forceKillTimeout);
    });
}

// ==========================================================================
// HTTP Kiszolgáló & Útvonalak (Routing)
// ==========================================================================

const server = http.createServer((req, res) => {
    const url = req.url;
    const method = req.method;
    const cookies = parseCookies(req);
    const isAuthenticated = activeSessions.has(cookies.SessionId);

    // 1) Statikus fájlok kiszolgálása
    if (method === 'GET') {
        let filePath = '';
        let contentType = 'text/html; charset=utf-8';

        if (url === '/' || url === '/index.html') {
            filePath = path.join(PUBLIC_DIR, 'index.html');
        } else if (url === '/admin' || url === '/admin.html') {
            // Nem irányítunk át azonnal szerveroldalon, az admin.html-ben lévő JS kezeli a Login overlay-t.
            filePath = path.join(PUBLIC_DIR, 'admin.html');
        } else if (url === '/style.css') {
            filePath = path.join(PUBLIC_DIR, 'style.css');
            contentType = 'text/css';
        } else if (url === '/portal.js') {
            filePath = path.join(PUBLIC_DIR, 'portal.js');
            contentType = 'application/javascript';
        } else if (url === '/admin.js') {
            filePath = path.join(PUBLIC_DIR, 'admin.js');
            contentType = 'application/javascript';
        }

        if (filePath) {
            fs.readFile(filePath, (err, content) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Belső Szerver Hiba');
                } else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content);
                }
            });
            return;
        }
    }

    // 2) SSE Csatorna (Valós idejű szerver állapotok és logok)
    if (method === 'GET' && url === '/api/status-stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Kliens hozzáadása a listához
        sseClients.push(res);

        // Első csatlakozáskor elküldjük az eddigi log history-t
        res.write(`event: history\ndata: ${JSON.stringify(logHistory)}\n\n`);
        
        // Azonnali stat frissítés küldése
        sendStatsUpdate();

        req.on('close', () => {
            sseClients = sseClients.filter(c => c !== res);
            res.end();
        });
        return;
    }

    // 3) Fiók Regisztráció (Játékosoknak)
    if (method === 'POST' && url === '/api/register') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                if (!username || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Hiányzó felhasználónév vagy jelszó!' }));
                }

                if (username.length < 3 || username.length > 16 || !/^[a-zA-Z0-9]+$/.test(username)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'A felhasználónév 3-16 karakter hosszú lehet, és csak betűket/számokat tartalmazhat!' }));
                }

                if (worldState !== 'running' || !worldProcess) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'A játékvilág (Worldserver) jelenleg offline. Regisztráció nem lehetséges!' }));
                }

                addSystemLog(`Fiók regisztrációs kérés: ${username}`);
                
                // Parancs küldése a Worldserver-nek: account create <user> <pass>
                worldProcess.stdin.write(`account create ${username} ${password}\n`);

                // Válasz figyelése a kimeneten
                let resolved = false;
                
                const responseListener = (data) => {
                    const text = data.toString();
                    if (text.includes(`Account created: ${username}`) || text.includes(`Account created: ${username.toUpperCase()}`)) {
                        cleanup(true, 'Fiók sikeresen létrehozva!');
                    } else if (text.includes(`Account ${username} already exists`) || text.includes('already exists') || text.includes('already exist')) {
                        cleanup(false, 'Ez a felhasználónév már foglalt!');
                    }
                };

                const timeout = setTimeout(() => {
                    cleanup(true, 'A regisztrációs kérés elküldve (időtúllépés a válasz ellenőrzésekor).');
                }, 1500);

                function cleanup(success, message) {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    worldProcess.stdout.removeListener('data', responseListener);
                    
                    if (success) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message }));
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message }));
                    }
                }

                worldProcess.stdout.on('data', responseListener);

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Regisztrációs hiba!' }));
            }
        });
        return;
    }

    // 4) Admin bejelentkezés ellenőrzése
    if (method === 'GET' && url === '/api/admin/check-auth') {
        const setupRequired = !hasAdminPassword();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            authenticated: isAuthenticated,
            setupRequired: setupRequired
        }));
        return;
    }

    // 5) Admin login
    if (method === 'POST' && url === '/api/admin/login') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                const currentPassword = getAdminPassword();

                if (!currentPassword) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'A rendszer nincs konfigurálva! Kérjük állítsd be a jelszót először.' }));
                }

                if (password === currentPassword) {
                    const sessionId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
                    activeSessions.add(sessionId);

                    res.writeHead(200, {
                        'Set-Cookie': `SessionId=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Hibás adminisztrátori jelszó!' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Hibás kérés!' }));
            }
        });
        return;
    }

    // 5/b) Admin első beállítás (Setup)
    if (method === 'POST' && url === '/api/admin/setup') {
        if (hasAdminPassword()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'A jelszó már be van állítva!' }));
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (!password || password.length < 6) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'A jelszónak legalább 6 karakternek kell lennie!' }));
                }

                if (setAdminPassword(password)) {
                    const sessionId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
                    activeSessions.add(sessionId);

                    res.writeHead(200, {
                        'Set-Cookie': `SessionId=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({ success: true }));
                    addSystemLog('Az adminisztrátori jelszó sikeresen beállítva az első használat során.');
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Nem sikerült elmenteni a jelszót!' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Hibás kérés!' }));
            }
        });
        return;
    }

    // 6) Admin logout
    if (method === 'POST' && url === '/api/admin/logout') {
        if (cookies.SessionId) {
            activeSessions.delete(cookies.SessionId);
        }
        res.writeHead(200, {
            'Set-Cookie': 'SessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly',
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ==========================================================================
    // Védett Admin API-k (Csak belépett gépészeknek)
    // ==========================================================================
    if (!isAuthenticated) {
        if (url.startsWith('/api/admin/')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Unauthorized' }));
        }
    }

    // 7) GM Parancs küldése a Worldservernek
    if (method === 'POST' && url === '/api/admin/command') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { command } = JSON.parse(body);
                if (!command) {
                    res.writeHead(400);
                    return res.end();
                }

                if (worldState !== 'running' || !worldProcess) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'A Worldserver nem fut!' }));
                }

                addLog('input', `GM parancs: ${command}`);
                
                // Parancs beírása a worldserver stdin-re (levágjuk a pontot az elejéről ha konzolból jön, bár az azerothcore konzol pont nélkül is elfogadja a GM parancsokat, de a ponttal együtt is működik általában)
                worldProcess.stdin.write(`${command}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

            } catch (err) {
                res.writeHead(500);
                res.end();
            }
        });
        return;
    }

    // 8) Szerver folyamatok indítása / leállítása / újraindítása
    if (method === 'POST' && url === '/api/admin/control') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { service, action } = JSON.parse(body);
                if (!service || !action) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Hiányzó paraméterek' }));
                }

                addSystemLog(`Vezérlési parancs: ${service} -> ${action}`);

                if (service === 'authserver') {
                    if (action === 'start') startAuthserver();
                    else if (action === 'stop') stopAuthserver();
                    else if (action === 'restart') {
                        stopAuthserver();
                        setTimeout(startAuthserver, 2000);
                    }
                } else if (service === 'worldserver') {
                    if (action === 'start') startWorldserver();
                    else if (action === 'stop') stopWorldserver();
                    else if (action === 'restart') {
                        stopWorldserver();
                        setTimeout(startWorldserver, 5000);
                    }
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Ismeretlen folyamat' }));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

            } catch (err) {
                res.writeHead(500);
                res.end();
            }
        });
        return;
    }

    // 9) Modulok listájának lekérdezése
    if (method === 'GET' && url === '/api/admin/modules') {
        const modules = getSavedModules();
        const rebuildRequired = checkRebuildRequired();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ modules, rebuildRequired }));
        return;
    }

    // 10) Modul hozzáadása vagy eltávolítása a listából
    if (method === 'POST' && url === '/api/admin/modules') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { action, url: moduleUrl } = JSON.parse(body);
                if (!action || !moduleUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Hiányzó paraméterek!' }));
                }

                let modules = getSavedModules();

                if (action === 'add') {
                    if (!moduleUrl.startsWith('http://') && !moduleUrl.startsWith('https://') && !moduleUrl.startsWith('git@')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ message: 'Érvénytelen Git URL!' }));
                    }

                    if (modules.includes(moduleUrl)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ message: 'Ez a modul már hozzá van adva!' }));
                    }

                    modules.push(moduleUrl);
                    saveSavedModules(modules);
                    addSystemLog(`Modul hozzáadva a listához: ${moduleUrl}`);

                } else if (action === 'delete') {
                    modules = modules.filter(m => m !== moduleUrl);
                    saveSavedModules(modules);
                    addSystemLog(`Modul törölve a listáról: ${moduleUrl}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Szerveroldali hiba!' }));
            }
        });
        return;
    }

    // 11) Szerver újrafordítás indítása (Rebuild)
    if (method === 'POST' && url === '/api/admin/rebuild') {
        if (rebuildStatus === 'building') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'A fordítás már folyamatban van!' }));
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            let mode = 'full';
            try { mode = JSON.parse(body).mode || 'full'; } catch(e) {}
            
            // Indítás a háttérben
            runRebuild(mode);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // 12) Tool exportálás a host mappába
    if (method === 'POST' && url === '/api/admin/export-tools') {
        const toolsDir = '/host-configs/tools';
        const binDir = '/opt/acore/bin';
        const possibleTools = [
            'map_extractor', 'mapextractor',
            'vmap4_extractor', 'vmap4extractor',
            'vmap4_assembler', 'vmap4assembler',
            'mmaps_generator'
        ];

        try {
            fs.mkdirSync(toolsDir, { recursive: true });
            const exported = [];
            const missing = [];

            // Csoportosítjuk a kívánt toolokat (ha valamelyik verzió megvan, akkor a fő tool megvan)
            const toolGroups = [
                { key: 'mapextractor', names: ['map_extractor', 'mapextractor'] },
                { key: 'vmap4extractor', names: ['vmap4_extractor', 'vmap4extractor'] },
                { key: 'vmap4assembler', names: ['vmap4_assembler', 'vmap4assembler'] },
                { key: 'mmaps_generator', names: ['mmaps_generator'] }
            ];

            toolGroups.forEach(group => {
                let found = false;
                group.names.forEach(name => {
                    const src = path.join(binDir, name);
                    const dst = path.join(toolsDir, name);
                    if (fs.existsSync(src)) {
                        fs.copyFileSync(src, dst);
                        fs.chmodSync(dst, 0o755);
                        exported.push(name);
                        found = true;
                    }
                });
                if (!found) {
                    missing.push(group.key);
                }
            });

            // Generáljuk le a segéd-szkripteket is a célmappába
            if (exported.length > 0) {
                const shContent = `#!/bin/bash
# ============================================================
#  AzerothCore Client Data Extractor (All-in-One)
#  Futtasd ezt a scriptet a WoW 3.3.5a kliens főkönyvtárában!
# ============================================================

set -e

if [ ! -d "Data" ] && [ ! -d "data" ]; then
    echo "HIBA: Úgy tűnik, nem a WoW kliens főkönyvtárában vagy."
    echo "Másold be ezt a scriptet és az exportált toolokat a WoW kliens mellé!"
    exit 1
fi

echo "=============================================="
echo "  AzerothCore All-in-One Extractor"
echo "=============================================="
echo ""

MAP_EXTRACTOR="./map_extractor"
if [ ! -f "$MAP_EXTRACTOR" ]; then MAP_EXTRACTOR="./mapextractor"; fi

VMAP_EXTRACTOR="./vmap4_extractor"
if [ ! -f "$VMAP_EXTRACTOR" ]; then VMAP_EXTRACTOR="./vmap4extractor"; fi

VMAP_ASSEMBLER="./vmap4_assembler"
if [ ! -f "$VMAP_ASSEMBLER" ]; then VMAP_ASSEMBLER="./vmap4assembler"; fi

MMAP_GENERATOR="./mmaps_generator"
if [ ! -f "$MMAP_GENERATOR" ]; then MMAP_GENERATOR="./mmaps_generator"; fi

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
`;

                const batContent = `@echo off
REM ============================================================
REM  AzerothCore Client Data Extractor (All-in-One - Windows)
REM  Futtasd ezt a scriptet a WoW 3.3.5a kliens főkönyvtárában!
REM ============================================================

if not exist "Data" if not exist "data" (
    echo HIBA: Ugy tunik, nem a WoW kliens fokonyvtaraban vagy.
    echo Masold be ezt a scriptet es az exportalt toolokat a WoW kliens melle!
    pause
    exit /b 1
)

echo ==============================================
echo   AzerothCore All-in-One Extractor (Windows)
echo ==============================================
echo.

set MAP_EXTRACT_BIN=
if exist map_extractor.exe (set MAP_EXTRACT_BIN=map_extractor.exe) else (
    if exist mapextractor.exe (set MAP_EXTRACT_BIN=mapextractor.exe) else (
        if exist map_extractor (set MAP_EXTRACT_BIN=map_extractor) else (
            if exist mapextractor (set MAP_EXTRACT_BIN=mapextractor)
        )
    )
)

set VMAP_EXTRACT_BIN=
if exist vmap4_extractor.exe (set VMAP_EXTRACT_BIN=vmap4_extractor.exe) else (
    if exist vmap4extractor.exe (set VMAP_EXTRACT_BIN=vmap4extractor.exe) else (
        if exist vmap4_extractor (set VMAP_EXTRACT_BIN=vmap4_extractor) else (
            if exist vmap4extractor (set VMAP_EXTRACT_BIN=vmap4extractor)
        )
    )
)

set VMAP_ASSEM_BIN=
if exist vmap4_assembler.exe (set VMAP_ASSEM_BIN=vmap4_assembler.exe) else (
    if exist vmap4assembler.exe (set VMAP_ASSEM_BIN=vmap4assembler.exe) else (
        if exist vmap4_assembler (set VMAP_ASSEM_BIN=vmap4_assembler) else (
            if exist vmap4assembler (set VMAP_ASSEM_BIN=vmap4assembler)
        )
    )
)

set MMAP_GEN_BIN=
if exist mmaps_generator.exe (set MMAP_GEN_BIN=mmaps_generator.exe) else (
    if exist mmaps_generator (set MMAP_GEN_BIN=mmaps_generator)
)

if "%MAP_EXTRACT_BIN%"=="" (echo HIBA: map_extractor nem talalhato! & pause & exit /b 1)
if "%VMAP_EXTRACT_BIN%"=="" (echo HIBA: vmap4_extractor nem talalhato! & pause & exit /b 1)
if "%VMAP_ASSEM_BIN%"=="" (echo HIBA: vmap4_assembler nem talalhato! & pause & exit /b 1)
if "%MMAP_GEN_BIN%"=="" (echo HIBA: mmaps_generator nem talalhato! & pause & exit /b 1)

echo [1/4] Terkepek kicsomagolasa (Maps/DBC)...
%MAP_EXTRACT_BIN%
echo       [OK] Maps es DBC kicsomagolva!
echo.

echo [2/4] Vmaps kicsomagolasa (Vmaps Extractor)...
%VMAP_EXTRACT_BIN%
echo       [OK] Vmaps kicsomagolva!
echo.

echo [3/4] Vmaps osszeallitasa (Vmaps Assembler)...
if not exist vmaps mkdir vmaps
%VMAP_ASSEM_BIN% Buildings vmaps
echo       [OK] Vmaps osszeallitva!
echo.

echo [4/4] Mmaps generalasa (Mmaps Generator - ez eltarhat egy ideig)...
%MMAP_GEN_BIN%
echo       [OK] Mmaps generalva!
echo.

echo ==============================================
echo   MINDEN KESZ SIKERESEN!
echo   A keletkezett 'dbc', 'maps', 'vmaps' es 'mmaps' mappakat
echo   masold at a szerver 'configs/data/' konyvtaraba.
echo ==============================================
pause
`;
                try {
                    fs.writeFileSync(path.join(toolsDir, 'extractor.sh'), shContent, { mode: 0o755 });
                    fs.writeFileSync(path.join(toolsDir, 'extractor.bat'), batContent);
                    exported.push('extractor.sh', 'extractor.bat');
                } catch (e) {
                    addSystemLog(`Hiba a segéd-szkriptek generálásakor: ${e.message}`);
                }
            }

            const msg = exported.length > 0
                ? `Exportálva: ${exported.join(', ')}${missing.length ? ` | Nem található: ${missing.join(', ')}` : ''}`
                : 'Nem találhatók tool binárisok! Előbb végezd el a Teljes Újrafordítást.';

            addSystemLog(`Tool export: ${msg}`);
            res.writeHead(exported.length > 0 ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: exported.length > 0, exported, missing, message: msg }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Export hiba: ${err.message}` }));
        }
        return;
    }
    // 404 Not Found
    res.writeHead(404);
    res.end('404 A keresett lap nem található');
});

// ==========================================================================
// C++ Modul és Újrafordítás (Rebuild) segédfüggvények
// ==========================================================================

function hasAdminPassword() {
    if (process.env.ADMIN_PASSWORD) return true;
    return fs.existsSync(PASSWORD_FILE);
}

function getAdminPassword() {
    if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
    try {
        if (fs.existsSync(PASSWORD_FILE)) {
            return fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
        }
    } catch (err) {
        console.error('Hiba a jelszó olvasásakor:', err);
    }
    return null;
}

function setAdminPassword(password) {
    try {
        fs.writeFileSync(PASSWORD_FILE, password.trim(), 'utf8');
        return true;
    } catch (err) {
        console.error('Hiba a jelszó írásakor:', err);
        return false;
    }
}

function getSavedModules() {
    try {
        if (fs.existsSync(MODULES_CONFIG_FILE)) {
            const content = fs.readFileSync(MODULES_CONFIG_FILE, 'utf8');
            return JSON.parse(content) || [];
        }
    } catch (err) {
        console.error('Hiba a modules.json olvasásakor:', err);
    }
    return [];
}

function saveSavedModules(modules) {
    try {
        fs.writeFileSync(MODULES_CONFIG_FILE, JSON.stringify(modules, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('Hiba a modules.json írásakor:', err);
        return false;
    }
}

function checkRebuildRequired() {
    const saved = getSavedModules();
    const actualFolders = [];
    
    try {
        const modulesDir = '/acore/modules';
        if (fs.existsSync(modulesDir)) {
            const files = fs.readdirSync(modulesDir);
            files.forEach(file => {
                const fullPath = path.join(modulesDir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (file !== 'mod-playerbots' && file !== '.' && file !== '..') {
                        actualFolders.push(file);
                    }
                }
            });
        }
    } catch (err) {
        console.error('Hiba a modules mappa olvasásakor:', err);
    }

    const savedFolders = saved.map(url => {
        let name = url.substring(url.lastIndexOf('/') + 1);
        if (name.endsWith('.git')) name = name.substring(0, name.length - 4);
        return name;
    });

    if (savedFolders.length !== actualFolders.length) return true;

    for (const folder of savedFolders) {
        if (!actualFolders.includes(folder)) return true;
    }

    return false;
}

function runCommandAsync(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { cwd });
        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} hiba! Exit kód: ${code}`));
        });
    });
}

function runCommandWithLogs(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { cwd });
        
        const handleData = (data) => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) {
                    addLog('compiler', line);
                }
            });
        };

        proc.stdout.on('data', handleData);
        proc.stderr.on('data', handleData);

        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} hiba! Exit kód: ${code}`));
        });
    });
}

function runRebuild(mode) {
    if (rebuildStatus === 'building') return;
    rebuildStatus = 'building';
    mode = mode || 'full';
    
    addSystemLog(`Szerver újrafordítás elindult (mód: ${mode}). Szerverek leállítása...`);
    stopAuthserver();
    stopWorldserver();
    
    // Várunk a folyamatok leállására
    setTimeout(async () => {
        try {
            const saved = getSavedModules();
            const modulesDir = '/acore/modules';
            
            // 1. Git Szinkronizálás
            addSystemLog('1/3 Fázis: Git modulok szinkronizálása...');
            
            const savedMap = saved.map(url => {
                let name = url.substring(url.lastIndexOf('/') + 1);
                if (name.endsWith('.git')) name = name.substring(0, name.length - 4);
                return { url, folder: name };
            });

            // Törlés
            if (fs.existsSync(modulesDir)) {
                const actualFolders = fs.readdirSync(modulesDir).filter(file => {
                    const fullPath = path.join(modulesDir, file);
                    return fs.statSync(fullPath).isDirectory() && file !== 'mod-playerbots';
                });

                for (const folder of actualFolders) {
                    if (!savedMap.some(item => item.folder === folder)) {
                        addSystemLog(`Eltávolított modul könyvtárának törlése: ${folder}...`);
                        fs.rmSync(path.join(modulesDir, folder), { recursive: true, force: true });
                    }
                }
            } else {
                fs.mkdirSync(modulesDir, { recursive: true });
            }

            // Letöltés
            for (const item of savedMap) {
                const folderPath = path.join(modulesDir, item.folder);
                if (!fs.existsSync(folderPath)) {
                    addSystemLog(`Új modul letöltése: ${item.folder} tól ${item.url}...`);
                    await runCommandAsync('git', ['clone', item.url, folderPath], '/acore');
                }
            }

            // 2. CMake Konfiguráció (csak full módban)
            if (mode === 'full') {
                addSystemLog('2/3 Fázis: CMake konfiguráció futtatása...');
                if (!fs.existsSync('/acore/build')) {
                    fs.mkdirSync('/acore/build', { recursive: true });
                }
                await runCommandWithLogs('cmake', ['..', '-DCMAKE_INSTALL_PREFIX=/opt/acore', '-DTOOLS_BUILD=all'], '/acore/build');
            } else {
                addSystemLog('2/3 Fázis: CMake kihagyva (make-only mód).');
            }

            // 3. Make Fordítás & Telepítés
            addSystemLog('3/3 Fázis: C++ kód fordítása és telepítése (ez eltarthat 10-20 percig)...');
            const cpuCount = os.cpus().length || 2;
            await runCommandWithLogs('make', [`-j${cpuCount}`, 'install'], '/acore/build');

            addSystemLog('AZ ÚJRAFORDÍTÁS SIKERESEN BEFEJEZŐDÖTT!');
            rebuildStatus = 'idle';
            
            // Szerverek újraindítása
            startAuthserver();
            setTimeout(startWorldserver, 3000);

        } catch (err) {
            addSystemLog(`HIBA: A fordítási folyamat megszakadt: ${err.message}`);
            rebuildStatus = 'idle';
            
            // Szerverek újraindítása
            startAuthserver();
            setTimeout(startWorldserver, 3000);
        }
    }, 5000);
}

// ==========================================================================
// Rendszerindítás & Leállítás kezelés
// ==========================================================================

server.listen(PORT, '0.0.0.0', () => {
    addSystemLog(`Webes vezérlőpult elindult a http://0.0.0.0:${PORT} címen.`);
    
    // Kezdeti folyamatok elindítása
    startAuthserver();
    
    // Kicsit várunk a worldserverrel, hogy a MySQL biztosan elérhető legyen
    setTimeout(startWorldserver, 3000);
});

// Statisztikák lekérdezése 2 másodpercenként
setInterval(sendStatsUpdate, 2000);

// Graceful exit handler konténer leállításakor
function gracefulShutdown(signal) {
    addSystemLog(`Leállítási jelzés érkezett (${signal}). Szerverek leállítása...`);
    
    stopAuthserver();
    stopWorldserver();

    // Várunk a folyamatok lefutására, majd bezárjuk a Node.js-t
    setTimeout(() => {
        addSystemLog('Webszerver leáll. Viszlát!');
        process.exit(0);
    }, 4000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
