const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

const PORT = 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_CONFIG_FILE = '/host-configs/modules.json';
const PASSWORD_FILE = '/host-configs/admin_password.txt';

// Global session storage
const activeSessions = new Set();

// Server process references
let authProcess = null;
let worldProcess = null;

let authState = 'stopped'; // stopped, starting, running
let worldState = 'stopped'; // stopped, starting, running
let rebuildStatus = 'idle'; // idle, building

let authPid = null;
let worldPid = null;
let mysqlPid = null;

// Log history buffer (last 200 lines)
const maxLogHistory = 200;
const logHistory = [];

// SSE clients list
let sseClients = [];

// Active player count (retrieved from worldserver .server info command, default 0)
let activePlayerCount = 0;
let worldUptime = 0; // in seconds
let worldStartTime = null;

// ==========================================================================
// Helper functions
// ==========================================================================

function addLog(service, text) {
    // Inline cleanup (e.g. removing colored ANSI codes if present)
    const cleanedText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
    if (!cleanedText) return;

    const logEntry = {
        time: new Date().toLocaleTimeString('en-US'),
        service, // 'world', 'auth', 'system', 'input'
        text: cleanedText
    };

    logHistory.push(logEntry);
    if (logHistory.length > maxLogHistory) {
        logHistory.shift();
    }

    // Broadcast to active SSE clients
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

// Cookie parsing
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
// Server Process Management (Spawn & Monitor)
// ==========================================================================

// Retrieve MySQL PID
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

// Retrieve CPU/RAM usage stats for a PID
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

function getOnlinePlayerCounts() {
    return new Promise((resolve) => {
        exec('mysql -uacore -pacorepass -D acore_characters -N -e "SELECT COUNT(*), SUM(IF(a.username NOT LIKE \'RNDBOT%\', 1, 0)) FROM characters c JOIN acore_auth.account a ON c.account = a.id WHERE c.online = 1"', (err, stdout) => {
            if (err || !stdout) {
                return resolve({ total: 0, real: 0 });
            }
            const parts = stdout.trim().split(/\s+/);
            const total = parseInt(parts[0]) || 0;
            const real = parseInt(parts[1]) || 0;
            resolve({ total, real });
        });
    });
}

// Regular stats updates and broadcasting
async function sendStatsUpdate() {
    await updateMysqlPid();
    
    const mysqlStats = mysqlPid ? await getProcessStats(mysqlPid) : { cpu: 0, ram: 0 };
    const authStats = authPid ? await getProcessStats(authPid) : { cpu: 0, ram: 0 };
    const worldStats = worldPid ? await getProcessStats(worldPid) : { cpu: 0, ram: 0 };

    // Calculate uptime if worldserver is running
    if (worldState === 'running' && worldStartTime) {
        worldUptime = Math.round((Date.now() - worldStartTime) / 1000);
        
        try {
            const counts = await getOnlinePlayerCounts();
            if (counts.real === 0 && counts.total === 0) {
                activePlayerCount = "0";
            } else {
                activePlayerCount = `${counts.real} (+${counts.total - counts.real} bot)`;
            }
        } catch (e) {
            activePlayerCount = "0";
        }
    } else {
        worldUptime = 0;
        activePlayerCount = "0";
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

// Process output stream handling line-by-line
function handleProcessOutput(process, name) {
    let buffer = '';
    process.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // put unfinished line back in buffer
        
        lines.forEach(line => {
            addLog(name, line);
            console.log(`[${name.toUpperCase()}] ${line}`);
            
            // Automatically reply "yes" to database upgrade and confirmation prompts
            if (name === 'world' && (line.includes('[yes (default) / no]:') || line.includes('Do you want to create it?') || line.includes('Do you want to apply'))) {
                addSystemLog('Database upgrade/confirmation prompt detected from Worldserver. Automatic reply: yes');
                process.stdin.write('yes\n');
            }
            
            // Monitor Worldserver startup phase
            if (name === 'world' && worldState === 'starting') {
                if (line.includes('World daemon-thread running') || line.includes('ready') || line.includes('max connections')) {
                    worldState = 'running';
                    worldStartTime = Date.now();
                    addSystemLog('Worldserver started successfully, ready for play!');
                    updateRealmlistIp();
                }
            }

            // Extract active player count from logs (e.g. when server info runs)
            if (name === 'world') {
                const match = line.match(/Players online:\s*(\d+)/i);
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
                console.error(`[${name.toUpperCase()} ERR] ${line}`);
            }
        });
    });
}

function startAuthserver() {
    if (authState !== 'stopped') return;
    authState = 'starting';
    addSystemLog('Starting Authserver...');

    try {
        authProcess = spawn('/opt/acore/bin/authserver', [], {
            cwd: '/opt/acore/bin',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        authPid = authProcess.pid;
        authState = 'running';
        addSystemLog(`Authserver started (PID: ${authPid})`);

        handleProcessOutput(authProcess, 'auth');

        authProcess.on('exit', (code) => {
            addSystemLog(`Authserver stopped. Exit code: ${code}`);
            authState = 'stopped';
            authPid = null;
            authProcess = null;
        });
    } catch (err) {
        addSystemLog(`Error starting Authserver: ${err.message}`);
        authState = 'stopped';
        authPid = null;
    }
}

function startWorldserver() {
    if (worldState !== 'stopped') return;
    worldState = 'starting';
    addSystemLog('Starting Worldserver...');

    try {
        worldProcess = spawn('/opt/acore/bin/worldserver', [], {
            cwd: '/opt/acore/bin',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        worldPid = worldProcess.pid;
        addSystemLog(`Worldserver process started (PID: ${worldPid}). Loading databases...`);

        handleProcessOutput(worldProcess, 'world');

        worldProcess.on('exit', (code) => {
            addSystemLog(`Worldserver stopped. Exit code: ${code}`);
            worldState = 'stopped';
            worldPid = null;
            worldProcess = null;
            worldStartTime = null;
            activePlayerCount = 0;
        });
    } catch (err) {
        addSystemLog(`Error starting Worldserver: ${err.message}`);
        worldState = 'stopped';
        worldPid = null;
    }
}

function stopAuthserver() {
    if (authState === 'stopped' || !authProcess) return;
    addSystemLog('Stopping Authserver (SIGINT)...');
    authProcess.kill('SIGINT');
}

function stopWorldserver() {
    if (worldState === 'stopped' || !worldProcess) return;
    addSystemLog('Stopping Worldserver (sending graceful shutdown command)...');
    
    // Clean shutdown via WoW console
    worldProcess.stdin.write('shutdown 0\n');

    // Safety timeout: if it does not stop in 15 seconds, kill it
    const forceKillTimeout = setTimeout(() => {
        if (worldProcess) {
            addSystemLog('Worldserver did not stop in time. Forcing termination (SIGKILL)...');
            worldProcess.kill('SIGKILL');
        }
    }, 15000);

    worldProcess.once('exit', () => {
        clearTimeout(forceKillTimeout);
    });
}

// ==========================================================================
// HTTP Server & Routing
// ==========================================================================

const server = http.createServer((req, res) => {
    const url = req.url;
    const method = req.method;
    const cookies = parseCookies(req);
    const isAuthenticated = activeSessions.has(cookies.SessionId);

    // 1) Serve static files
    if (method === 'GET') {
        let filePath = '';
        let contentType = 'text/html; charset=utf-8';

        if (url === '/' || url === '/index.html') {
            filePath = path.join(PUBLIC_DIR, 'index.html');
        } else if (url === '/admin' || url === '/admin.html') {
            // Do not redirect immediately on the server-side, JS in admin.html handles the Login overlay.
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
                    res.end('Internal Server Error');
                } else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content);
                }
            });
            return;
        }
    }

    // 2) SSE Channel (Real-time server statuses and logs)
    if (method === 'GET' && url === '/api/status-stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Add client to list
        sseClients.push(res);

        // Send existing log history on first connection
        res.write(`event: history\ndata: ${JSON.stringify(logHistory)}\n\n`);
        
        // Send immediate stats update
        sendStatsUpdate();

        req.on('close', () => {
            sseClients = sseClients.filter(c => c !== res);
            res.end();
        });
        return;
    }

    // 3) Account Registration (For Players)
    if (method === 'POST' && url === '/api/register') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                if (!username || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Missing username or password!' }));
                }

                if (username.length < 3 || username.length > 16 || !/^[a-zA-Z0-9]+$/.test(username)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Username must be 3-16 characters long and can only contain letters and numbers!' }));
                }

                if (worldState !== 'running' || !worldProcess) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'The game world (Worldserver) is currently offline. Registration is not possible!' }));
                }

                addSystemLog(`Account registration request: ${username}`);
                
                // Send command to Worldserver: account create <user> <pass>
                worldProcess.stdin.write(`account create ${username} ${password}\n`);

                // Monitor response in output
                let resolved = false;
                
                const responseListener = (data) => {
                    const text = data.toString();
                    if (text.includes(`Account created: ${username}`) || text.includes(`Account created: ${username.toUpperCase()}`)) {
                        cleanup(true, 'Account successfully created!');
                    } else if (text.includes(`Account ${username} already exists`) || text.includes('already exists') || text.includes('already exist')) {
                        cleanup(false, 'This username is already taken!');
                    }
                };

                const timeout = setTimeout(() => {
                    cleanup(true, 'Registration request sent (timeout verifying response).');
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
                res.end(JSON.stringify({ message: 'Registration error!' }));
            }
        });
        return;
    }

    // 4) Check Admin Login
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
                    return res.end(JSON.stringify({ message: 'The system is not configured! Please set up the password first.' }));
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
                    res.end(JSON.stringify({ message: 'Incorrect administrator password!' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Invalid request!' }));
            }
        });
        return;
    }

    // 5/b) Admin Setup
    if (method === 'POST' && url === '/api/admin/setup') {
        if (hasAdminPassword()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'The password is already set!' }));
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (!password || password.length < 6) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'The password must be at least 6 characters long!' }));
                }

                if (setAdminPassword(password)) {
                    const sessionId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
                    activeSessions.add(sessionId);

                    res.writeHead(200, {
                        'Set-Cookie': `SessionId=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({ success: true }));
                    addSystemLog('Administrator password set successfully during setup.');
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Failed to save the password!' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Invalid request!' }));
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
    // Protected Admin APIs (Logged in administrators only)
    // ==========================================================================
    if (!isAuthenticated) {
        if (url.startsWith('/api/admin/')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Unauthorized' }));
        }
    }

    // 7) Send GM Command to Worldserver
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
                    return res.end(JSON.stringify({ message: 'Worldserver is not running!' }));
                }

                addLog('input', `GM command: ${command}`);
                
                // Write command to worldserver stdin
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

    // 8) Start / stop / restart server processes
    if (method === 'POST' && url === '/api/admin/control') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { service, action } = JSON.parse(body);
                if (!service || !action) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Missing parameters' }));
                }

                addSystemLog(`Control command: ${service} -> ${action}`);

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
                    return res.end(JSON.stringify({ message: 'Unknown process' }));
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

    // 9) Query custom modules list
    if (method === 'GET' && url === '/api/admin/modules') {
        const modules = getSavedModules();
        const rebuildRequired = checkRebuildRequired();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ modules, rebuildRequired }));
        return;
    }

    // 10) Add or remove module from the list
    if (method === 'POST' && url === '/api/admin/modules') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { action, url: moduleUrl } = JSON.parse(body);
                if (!action || !moduleUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Missing parameters!' }));
                }

                let modules = getSavedModules();

                if (action === 'add') {
                    if (!moduleUrl.startsWith('http://') && !moduleUrl.startsWith('https://') && !moduleUrl.startsWith('git@')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ message: 'Invalid Git URL!' }));
                    }

                    if (modules.includes(moduleUrl)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ message: 'This module is already added!' }));
                    }

                    modules.push(moduleUrl);
                    saveSavedModules(modules);
                    addSystemLog(`Module added to the list: ${moduleUrl}`);

                } else if (action === 'delete') {
                    modules = modules.filter(m => m !== moduleUrl);
                    saveSavedModules(modules);
                    addSystemLog(`Module removed from the list: ${moduleUrl}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Server-side error!' }));
            }
        });
        return;
    }

    // 11) Start server rebuild
    if (method === 'POST' && url === '/api/admin/rebuild') {
        if (rebuildStatus === 'building') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Compilation already in progress!' }));
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            let mode = 'full';
            try { mode = JSON.parse(body).mode || 'full'; } catch(e) {}
            
            // Start in background
            runRebuild(mode);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // 12) Export tools to host folder
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

            // Group the desired tools
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

            // Also generate helper scripts in the destination folder
            if (exported.length > 0) {
                const shContent = `#!/bin/bash
# ============================================================
#  AzerothCore Client Data Extractor (All-in-One)
#  Run this script in the root directory of your WoW 3.3.5a client!
# ============================================================

set -e

if [ ! -d "Data" ] && [ ! -d "data" ]; then
    echo "ERROR: It seems you are not in the WoW client root directory."
    echo "Copy this script and the exported tools next to your WoW client!"
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
        echo "ERROR: The '$bin' tool was not found in this folder!"
        echo "Please copy the exported files here."
        exit 1
    fi
    chmod +x "$bin"
done

echo "[1/4] Extracting maps (Maps/DBC)..."
"$MAP_EXTRACTOR"
echo "      ✓ Maps and DBC extracted!"
echo ""

echo "[2/4] Extracting Vmaps (Vmaps Extractor)..."
"$VMAP_EXTRACTOR"
echo "      ✓ Vmaps extracted!"
echo ""

echo "[3/4] Assembling Vmaps (Vmaps Assembler)..."
mkdir -p vmaps
"$VMAP_ASSEMBLER" Buildings vmaps
echo "      ✓ Vmaps assembled!"
echo ""

echo "[4/4] Generating Mmaps (Mmaps Generator - this may take a while)..."
"$MMAP_GENERATOR"
echo "      ✓ Mmaps generated!"
echo ""

echo "=============================================="
echo "  ALL COMPLETED SUCCESSFULLY!"
echo "  Copy the generated 'dbc', 'maps', 'vmaps' and 'mmaps' folders"
echo "  to the server 'configs/data/' directory."
echo "=============================================="
`;

                const batContent = `@echo off
REM ============================================================
REM  AzerothCore Client Data Extractor (All-in-One - Windows)
REM  Run this script in the root directory of your WoW 3.3.5a client!
REM ============================================================

if not exist "Data" if not exist "data" (
    echo ERROR: It seems you are not in the WoW client root directory.
    echo Copy this script and the exported tools next to your WoW client!
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

if "%MAP_EXTRACT_BIN%"=="" (echo ERROR: map_extractor not found! & pause & exit /b 1)
if "%VMAP_EXTRACT_BIN%"=="" (echo ERROR: vmap4_extractor not found! & pause & exit /b 1)
if "%VMAP_ASSEM_BIN%"=="" (echo ERROR: vmap4_assembler not found! & pause & exit /b 1)
if "%MMAP_GEN_BIN%"=="" (echo ERROR: mmaps_generator not found! & pause & exit /b 1)

echo [1/4] Extracting maps (Maps/DBC)...
%MAP_EXTRACT_BIN%
echo       [OK] Maps and DBC extracted!
echo.

echo [2/4] Extracting Vmaps (Vmaps Extractor)...
%VMAP_EXTRACT_BIN%
echo       [OK] Vmaps extracted!
echo.

echo [3/4] Assembling Vmaps (Vmaps Assembler)...
if not exist vmaps mkdir vmaps
%VMAP_ASSEM_BIN% Buildings vmaps
echo       [OK] Vmaps assembled!
echo.

echo [4/4] Generating Mmaps (Mmaps Generator - this may take a while)...
%MMAP_GEN_BIN%
echo       [OK] Mmaps generated!
echo.

echo ==============================================
echo   ALL COMPLETED SUCCESSFULLY!
echo   Copy the generated 'dbc', 'maps', 'vmaps' and 'mmaps' folders
echo   to the server 'configs/data/' directory.
echo ==============================================
pause
`;
                try {
                    fs.writeFileSync(path.join(toolsDir, 'extractor.sh'), shContent, { mode: 0o755 });
                    fs.writeFileSync(path.join(toolsDir, 'extractor.bat'), batContent);
                    exported.push('extractor.sh', 'extractor.bat');
                } catch (e) {
                    addSystemLog(`Error generating helper scripts: ${e.message}`);
                }
            }

            const msg = exported.length > 0
                ? `Exported: ${exported.join(', ')}${missing.length ? ` | Not found: ${missing.join(', ')}` : ''}`
                : 'No tool binaries found! Complete Full Recompilation first.';

            addSystemLog(`Tool export: ${msg}`);
            res.writeHead(exported.length > 0 ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: exported.length > 0, exported, missing, message: msg }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Export error: ${err.message}` }));
        }
        return;
    }
    // 404 Not Found
    res.writeHead(404);
    res.end('404 Page Not Found');
});

// ==========================================================================
// C++ Module and Rebuild helper functions
// ==========================================================================

function updateRealmlistIp() {
    return new Promise((resolve) => {
        let realmIp = process.env.REALM_IP || '';
        
        if (!realmIp) {
            // Auto-detect inside container as fallback
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        realmIp = iface.address;
                        break;
                    }
                }
                if (realmIp) break;
            }
        }
        
        if (!realmIp) {
            realmIp = '127.0.0.1';
        }
        
        addSystemLog(`Updating realmlist address in database to: ${realmIp}`);
        
        const query = `UPDATE realmlist SET address = '${realmIp}';`;
        exec(`mysql -uacore -pacorepass -D acore_auth -e "${query}"`, (err, stdout, stderr) => {
            if (err) {
                addSystemLog(`Failed to update realmlist address: ${err.message || stderr}`);
            } else {
                addSystemLog(`Successfully updated realmlist address to ${realmIp} in database.`);
            }
            resolve();
        });
    });
}

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
        console.error('Error reading password:', err);
    }
    return null;
}

function setAdminPassword(password) {
    try {
        fs.writeFileSync(PASSWORD_FILE, password.trim(), 'utf8');
        return true;
    } catch (err) {
        console.error('Error writing password:', err);
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
        console.error('Error reading modules.json:', err);
    }
    return [];
}

function saveSavedModules(modules) {
    try {
        fs.writeFileSync(MODULES_CONFIG_FILE, JSON.stringify(modules, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('Error writing modules.json:', err);
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
        console.error('Error reading modules folder:', err);
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
            else reject(new Error(`${command} failed! Exit code: ${code}`));
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
                    console.log(`[COMPILER] ${line}`);
                }
            });
        };

        proc.stdout.on('data', handleData);
        proc.stderr.on('data', handleData);

        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} failed! Exit code: ${code}`));
        });
    });
}

function runRebuild(mode) {
    if (rebuildStatus === 'building') return;
    rebuildStatus = 'building';
    mode = mode || 'full';
    
    addSystemLog(`Server rebuild started (mode: ${mode}). Stopping servers...`);
    stopAuthserver();
    stopWorldserver();
    
    // Wait for processes to exit
    setTimeout(async () => {
        try {
            const saved = getSavedModules();
            const modulesDir = '/acore/modules';
            
            // 1. Git Synchronization
            addSystemLog('Phase 1/3: Synchronizing Git modules...');
            
            const savedMap = saved.map(url => {
                let name = url.substring(url.lastIndexOf('/') + 1);
                if (name.endsWith('.git')) name = name.substring(0, name.length - 4);
                return { url, folder: name };
            });

            // Cleanup removed modules
            if (fs.existsSync(modulesDir)) {
                const actualFolders = fs.readdirSync(modulesDir).filter(file => {
                    const fullPath = path.join(modulesDir, file);
                    return fs.statSync(fullPath).isDirectory() && file !== 'mod-playerbots';
                });

                for (const folder of actualFolders) {
                    if (!savedMap.some(item => item.folder === folder)) {
                        addSystemLog(`Deleting removed module directory: ${folder}...`);
                        fs.rmSync(path.join(modulesDir, folder), { recursive: true, force: true });
                    }
                }
            } else {
                fs.mkdirSync(modulesDir, { recursive: true });
            }

            // Download new modules
            for (const item of savedMap) {
                const folderPath = path.join(modulesDir, item.folder);
                if (!fs.existsSync(folderPath)) {
                    addSystemLog(`Downloading new module: ${item.folder} from ${item.url}...`);
                    await runCommandAsync('git', ['clone', item.url, folderPath], '/acore');
                }
            }

            // 2. CMake Configuration (full mode only)
            if (mode === 'full') {
                addSystemLog('Phase 2/3: Running CMake configuration...');
                if (!fs.existsSync('/acore/build')) {
                    fs.mkdirSync('/acore/build', { recursive: true });
                }
                await runCommandWithLogs('cmake', ['..', '-DCMAKE_INSTALL_PREFIX=/opt/acore', '-DTOOLS_BUILD=all'], '/acore/build');
            } else {
                addSystemLog('Phase 2/3: CMake skipped (make-only mode).');
            }

            // 3. Make Compilation & Installation
            addSystemLog('Phase 3/3: Compiling and installing C++ code (this may take 10-20 minutes)...');
            const cpuCount = os.cpus().length || 2;
            await runCommandWithLogs('make', [`-j${cpuCount}`, 'install'], '/acore/build');

            addSystemLog('REBUILD COMPLETED SUCCESSFULLY!');
            rebuildStatus = 'idle';
            
            // Restart servers
            startAuthserver();
            setTimeout(startWorldserver, 3000);

        } catch (err) {
            addSystemLog(`ERROR: Compilation process interrupted: ${err.message}`);
            rebuildStatus = 'idle';
            
            // Restart servers
            startAuthserver();
            setTimeout(startWorldserver, 3000);
        }
    }, 5000);
}

// ==========================================================================
// Startup & Shutdown handling
// ==========================================================================

server.listen(PORT, '0.0.0.0', () => {
    addSystemLog(`Web dashboard started at http://0.0.0.0:${PORT}`);
    
    // Start initial processes
    startAuthserver();
    
    // Wait a moment for worldserver to ensure MySQL is available
    setTimeout(startWorldserver, 3000);
});

// Query stats every 2 seconds
setInterval(sendStatsUpdate, 2000);

// Graceful exit handler on container shutdown
function gracefulShutdown(signal) {
    addSystemLog(`Shutdown signal received (${signal}). Stopping servers...`);
    
    stopAuthserver();
    stopWorldserver();

    // Wait for processes to exit, then close Node.js
    setTimeout(() => {
        addSystemLog('Web server shutting down. Goodbye!');
        process.exit(0);
    }, 4000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
