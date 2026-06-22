let currentFilter = 'all';
let commandHistory = [];
let historyIndex = -1;
let sseSource = null;

// Kezdeti ellenőrzés betöltődéskor
window.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    
    // Console form submit
    document.getElementById('console-form').addEventListener('submit', (e) => {
        e.preventDefault();
        sendConsoleCommand();
    });

    // Console input history (Up/Down arrow)
    const consoleInput = document.getElementById('console-input');
    consoleInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
                historyIndex++;
                consoleInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                consoleInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
            } else if (historyIndex === 0) {
                historyIndex = -1;
                consoleInput.value = '';
            }
        }
    });

    // Login form submit
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        login();
    });
});

// Hitelesítés ellenőrzése
function checkAuth() {
    fetch('/api/admin/check-auth')
        .then(res => {
            if (res.ok) {
                showAdminPanel();
            } else {
                showLoginOverlay();
            }
        })
        .catch(() => {
            showLoginOverlay();
        });
}

function showLoginOverlay() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('admin-content').classList.add('hidden');
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }
}

function showAdminPanel() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-content').classList.remove('hidden');
    initAdminStream();
}

// Bejelentkezés
function login() {
    const password = document.getElementById('admin-password').value;
    const messageBox = document.getElementById('login-message');
    const submitBtn = document.getElementById('btn-login');

    messageBox.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Belépés...';

    fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    })
    .then(async (res) => {
        if (res.ok) {
            document.getElementById('admin-password').value = '';
            showAdminPanel();
        } else {
            const data = await res.json();
            messageBox.classList.remove('hidden');
            messageBox.textContent = data.message || 'Sikertelen bejelentkezés!';
        }
    })
    .catch(() => {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'Szerver kapcsolódási hiba!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Belépés';
    });
}

// Kijelentkezés
function logout() {
    fetch('/api/admin/logout', { method: 'POST' })
        .then(() => {
            showLoginOverlay();
        });
}

// SSE Kapcsolat inicializálása
function initAdminStream() {
    if (sseSource) {
        sseSource.close();
    }

    const term = document.getElementById('terminal-output');
    term.innerHTML = '<div class="terminal-line system-msg">[Rendszer] Kapcsolat felépítése...</div>';

    sseSource = new EventSource('/api/status-stream');

    // Stats event (Szerver állapotok, CPU, RAM)
    sseSource.addEventListener('stats', (event) => {
        const stats = JSON.parse(event.data);
        updateProcessUI('mysql', stats.mysql);
        updateProcessUI('authserver', stats.authserver);
        updateProcessUI('worldserver', stats.worldserver);
    });

    // Kezdeti log history fogadása
    sseSource.addEventListener('history', (event) => {
        const history = JSON.parse(event.data);
        term.innerHTML = ''; // Clear connection msgs
        history.forEach(log => {
            appendLogLine(log);
        });
        scrollToBottom();
    });

    // Új log sor fogadása
    sseSource.addEventListener('log', (event) => {
        const log = JSON.parse(event.data);
        appendLogLine(log);
        scrollToBottom();
    });

    sseSource.onerror = () => {
        const line = document.createElement('div');
        line.className = 'terminal-line system-msg';
        line.textContent = '[Rendszer] Hiba a naplófolyamban. Újracsatlakozás...';
        term.appendChild(line);
        scrollToBottom();
    };
}

// Folyamat kártya UI frissítése
function updateProcessUI(name, info) {
    const card = document.getElementById(`card-${name}`);
    if (!card) return;

    // Státusz szegélyek & fények
    const dot = card.querySelector('.status-dot');
    const lbl = card.querySelector('.status-lbl');
    
    dot.className = `status-dot ${info.status}`;
    
    let statusText = 'Offline';
    if (info.status === 'running') statusText = 'Running';
    if (info.status === 'starting') statusText = 'Starting';
    lbl.textContent = statusText;

    // CPU és RAM
    const cpuBar = document.getElementById(`${name}-cpu-bar`);
    const cpuVal = document.getElementById(`${name}-cpu-val`);
    const ramVal = document.getElementById(`${name}-ram-val`);

    if (cpuBar) cpuBar.style.width = `${Math.min(info.cpu, 100)}%`;
    if (cpuVal) cpuVal.textContent = `${info.cpu.toFixed(1)}%`;
    if (ramVal) ramVal.textContent = `${info.ram} MB`;

    // Gombok állapotai
    if (name !== 'mysql') {
        const btnStart = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-start`);
        const btnStop = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-stop`);
        const btnRestart = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-restart`);

        if (info.status === 'running') {
            btnStart.disabled = true;
            btnStop.disabled = false;
            btnRestart.disabled = false;
            
            // Ha a worldserver fut, engedélyezzük a konzol bevitelt
            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = false;
                document.getElementById('btn-send-command').disabled = false;
                document.getElementById('console-input').placeholder = "Írj be egy GM parancsot (pl. .server info vagy .reload all) és nyomj Entert...";
            }
        } else if (info.status === 'starting') {
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnRestart.disabled = true;
            
            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = true;
                document.getElementById('btn-send-command').disabled = true;
                document.getElementById('console-input').placeholder = "Worldserver indulás alatt. Kérjük várj...";
            }
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;
            btnRestart.disabled = true;

            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = true;
                document.getElementById('btn-send-command').disabled = true;
                document.getElementById('console-input').placeholder = "A konzol használatához indítsd el a Worldservert!";
            }
        }
    }
}

// Log sor hozzáadása a terminálhoz
function appendLogLine(log) {
    const term = document.getElementById('terminal-output');
    
    // Biztonsági korlát: maximum 1000 sor maradhat a DOM-ban
    if (term.childNodes.length > 1000) {
        term.removeChild(term.firstChild);
    }

    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.setAttribute('data-service', log.service);

    if (log.service === 'world') {
        line.classList.add('world-msg');
    } else if (log.service === 'auth') {
        line.classList.add('auth-msg');
    } else if (log.service === 'system') {
        line.classList.add('system-msg');
    } else if (log.service === 'input') {
        line.classList.add('input-msg');
    }

    // Időbélyeg hozzáadása, ha van
    const timeStr = log.time ? `[${log.time}] ` : '';
    const prefix = log.service === 'world' ? '[World] ' : 
                   log.service === 'auth' ? '[Auth] ' : '';
                   
    line.textContent = `${timeStr}${prefix}${log.text}`;

    // Szűrés alkalmazása az új sorra
    applyLineFilter(line);

    term.appendChild(line);
}

// Log sorok szűrése
function filterLogs(filterType) {
    currentFilter = filterType;
    
    // Gombok státusza
    document.getElementById('filter-all').className = `filter-btn ${filterType === 'all' ? 'active' : ''}`;
    document.getElementById('filter-world').className = `filter-btn ${filterType === 'world' ? 'active' : ''}`;
    document.getElementById('filter-auth').className = `filter-btn ${filterType === 'auth' ? 'active' : ''}`;

    // Sorok elrejtése/megjelenítése
    const lines = document.querySelectorAll('.terminal-line');
    lines.forEach(line => {
        applyLineFilter(line);
    });
    
    scrollToBottom();
}

function applyLineFilter(line) {
    const service = line.getAttribute('data-service');
    if (currentFilter === 'all') {
        line.classList.remove('hidden');
    } else if (currentFilter === 'world' && (service === 'world' || service === 'input' || service === 'system')) {
        line.classList.remove('hidden');
    } else if (currentFilter === 'auth' && (service === 'auth' || service === 'system')) {
        line.classList.remove('hidden');
    } else {
        line.classList.add('hidden');
    }
}

// Görgetés a terminál aljára
function scrollToBottom() {
    const term = document.getElementById('terminal-output');
    term.scrollTop = term.scrollHeight;
}

// Konzol parancs elküldése
function sendConsoleCommand() {
    const input = document.getElementById('console-input');
    const command = input.value.trim();
    if (!command) return;

    // Mentés az előzményekbe
    commandHistory.push(command);
    if (commandHistory.length > 50) {
        commandHistory.shift();
    }
    historyIndex = -1;

    // Helyi visszajelzés azonnal a terminálban
    appendLogLine({
        time: new Date().toLocaleTimeString(),
        service: 'input',
        text: `> ${command}`
    });
    scrollToBottom();
    
    input.value = '';

    fetch('/api/admin/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
    })
    .then(res => {
        if (!res.ok) {
            appendLogLine({
                time: new Date().toLocaleTimeString(),
                service: 'system',
                text: '[Rendszer] A parancs elküldése sikertelen volt (szerver hiba).'
            });
            scrollToBottom();
        }
    })
    .catch(() => {
        appendLogLine({
            time: new Date().toLocaleTimeString(),
            service: 'system',
            text: '[Rendszer] Nem sikerült elérni a szervert.'
        });
        scrollToBottom();
    });
}

// Gyorsparancs
function sendQuickCommand(cmd) {
    const input = document.getElementById('console-input');
    if (input.disabled) return;
    
    input.value = cmd;
    input.focus();
    
    // Ha befejezett parancs, rögtön küldjük is
    if (cmd !== '.account create ') {
        sendConsoleCommand();
    }
}

// Folyamat indítása / leállítása / újraindítása
function controlProcess(service, action) {
    const btnStart = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-start`);
    const btnStop = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-stop`);
    const btnRestart = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-restart`);

    // Gombok átmeneti letiltása
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    if (btnRestart) btnRestart.disabled = true;

    appendLogLine({
        time: new Date().toLocaleTimeString(),
        service: 'system',
        text: `[Rendszer] ${service} vezérlési kérés küldése: ${action}...`
    });
    scrollToBottom();

    fetch('/api/admin/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, action })
    })
    .then(async (res) => {
        if (!res.ok) {
            const data = await res.json();
            appendLogLine({
                time: new Date().toLocaleTimeString(),
                service: 'system',
                text: `[Rendszer] Hiba történt: ${data.message || 'Ismeretlen hiba'}`
            });
            scrollToBottom();
        }
    })
    .catch(() => {
        appendLogLine({
            time: new Date().toLocaleTimeString(),
            service: 'system',
            text: `[Rendszer] Nem sikerült a kapcsolatfelvétel a vezérlőhöz.`
        });
        scrollToBottom();
    });
}
