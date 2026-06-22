const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORT = 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Globális session tároló
const activeSessions = new Set();

// Szerver folyamatok referenciái
let authProcess = null;
let worldProcess = null;

let authState = 'stopped'; // stopped, starting, running
let worldState = 'stopped'; // stopped, starting, running

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
        playerCount: activePlayerCount
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
        if (isAuthenticated) {
            res.writeHead(200);
            res.end();
        } else {
            res.writeHead(401);
            res.end();
        }
        return;
    }

    // 5) Admin login
    if (method === 'POST' && url === '/api/admin/login') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === ADMIN_PASSWORD) {
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

    // 404 Not Found
    res.writeHead(404);
    res.end('404 A keresett lap nem található');
});

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
