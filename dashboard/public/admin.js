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

    // Setup form submit
    const setupForm = document.getElementById('setup-form');
    if (setupForm) {
        setupForm.addEventListener('submit', (e) => {
            e.preventDefault();
            setupPassword();
        });
    }

    // Modul hozzáadása form submit
    const addModuleForm = document.getElementById('add-module-form');
    if (addModuleForm) {
        addModuleForm.addEventListener('submit', (e) => {
            e.preventDefault();
            addModule();
        });
    }
});

// Hitelesítés ellenőrzése
function checkAuth() {
    fetch('/api/admin/check-auth')
        .then(res => res.json())
        .then(data => {
            if (data.authenticated) {
                showAdminPanel();
            } else {
                showLoginOverlay(data.setupRequired);
            }
        })
        .catch(() => {
            showLoginOverlay(false);
        });
}

function showLoginOverlay(setupRequired) {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('admin-content').classList.add('hidden');
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }

    const title = document.getElementById('login-card-title');
    const desc = document.getElementById('login-card-desc');
    const loginFm = document.getElementById('login-form');
    const setupFm = document.getElementById('setup-form');

    if (setupRequired) {
        title.textContent = 'Első Indítás: Admin Jelszó';
        desc.textContent = 'Adj meg egy biztonságos rendszergazda jelszót a szerver kezelőfelületéhez.';
        loginFm.classList.add('hidden');
        setupFm.classList.remove('hidden');
    } else {
        title.textContent = 'Gépész Bejelentkezés';
        desc.textContent = 'Add meg a titkos adminisztrátori jelszót a szerver kezeléséhez.';
        loginFm.classList.remove('hidden');
        setupFm.classList.add('hidden');
    }
}

// Első indítási jelszó mentés
function setupPassword() {
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-password-confirm').value;
    const messageBox = document.getElementById('login-message');
    const submitBtn = document.getElementById('btn-setup');

    messageBox.classList.add('hidden');

    if (password !== confirm) {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'A megadott jelszavak nem egyeznek!';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Mentés...';

    fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    })
    .then(async (res) => {
        if (res.ok) {
            document.getElementById('setup-password').value = '';
            document.getElementById('setup-password-confirm').value = '';
            showAdminPanel();
        } else {
            const data = await res.json();
            messageBox.classList.remove('hidden');
            messageBox.textContent = data.message || 'Hiba történt a mentés során!';
        }
    })
    .catch(() => {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'Kapcsolódási hiba!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Mentés & Belépés';
    });
}

function showAdminPanel() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-content').classList.remove('hidden');
    initAdminStream();
    loadModules();
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
        
        // Modul újrafordítás státuszának szinkronizálása
        updateRebuildUI(stats.rebuildStatus);
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
    } else if (log.service === 'compiler') {
        line.classList.add('compiler-msg');
    }

    // Időbélyeg hozzáadása, ha van
    const timeStr = log.time ? `[${log.time}] ` : '';
    const prefix = log.service === 'world' ? '[World] ' : 
                   log.service === 'auth' ? '[Auth] ' : 
                   log.service === 'compiler' ? '[Compiler] ' : '';
                   
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

// ==========================================================================
// C++ Modul Kezelő & Fordítás Logic
// ==========================================================================

// Modulok betöltése a szerverről
function loadModules() {
    const list = document.getElementById('module-list');
    if (!list) return;

    fetch('/api/admin/modules')
        .then(res => res.json())
        .then(data => {
            list.innerHTML = '';
            if (!data.modules || data.modules.length === 0) {
                list.innerHTML = '<li class="module-item loading">Nincs egyedi modul telepítve.</li>';
            } else {
                data.modules.forEach(mod => {
                    const li = document.createElement('li');
                    li.className = 'module-item';
                    
                    const name = getModuleName(mod);
                    li.innerHTML = `
                        <span class="module-url" title="${mod}">${name}</span>
                        <button onclick="deleteModule('${mod}')" class="delete-module-btn" title="Törlés">&times;</button>
                    `;
                    list.appendChild(li);
                });
            }

            // Újrafordítás figyelmeztetés
            const warningBox = document.getElementById('rebuild-warning-box');
            if (data.rebuildRequired) {
                warningBox.classList.remove('hidden');
            } else {
                warningBox.classList.add('hidden');
            }
        })
        .catch(() => {
            list.innerHTML = '<li class="module-item loading error">Hiba a modulok lekérésekor!</li>';
        });
}

// Modulnév kinyerése a Git URL-ből
function getModuleName(url) {
    if (!url) return '';
    const parts = url.split('/');
    let last = parts[parts.length - 1];
    if (last.endsWith('.git')) {
        last = last.substring(0, last.length - 4);
    }
    return last;
}

// Új modul hozzáadása
function addModule() {
    const input = document.getElementById('new-module-url');
    const url = input.value.trim();
    if (!url) return;

    input.disabled = true;

    fetch('/api/admin/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', url })
    })
    .then(async (res) => {
        if (res.ok) {
            input.value = '';
            loadModules();
        } else {
            const data = await res.json();
            alert(data.message || 'Hiba a modul hozzáadásakor!');
        }
    })
    .catch(() => {
        alert('Szerver kapcsolódási hiba!');
    })
    .finally(() => {
        input.disabled = false;
    });
}

// Modul törlése
function deleteModule(url) {
    if (!confirm(`Biztosan eltávolítod a(z) "${getModuleName(url)}" modult?`)) return;

    fetch('/api/admin/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', url })
    })
    .then(async (res) => {
        if (res.ok) {
            loadModules();
        } else {
            const data = await res.json();
            alert(data.message || 'Hiba a modul törlésekor!');
        }
    })
    .catch(() => {
        alert('Szerver kapcsolódási hiba!');
    });
}

// Újrafordítás indítása
function triggerRebuild(mode) {
    mode = mode || 'full';
    const modeLabel = mode === 'make-only' ? 'make install (cmake nélkül)' : 'teljes (cmake + make)';
    if (!confirm(`Figyelem: A szerver újrafordítása (${modeLabel}) leállítja a játékot, és 10-20 percet vehet igénybe. Elindítod?`)) return;

    setBuildingState(true);

    fetch('/api/admin/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
    })
        .then(async (res) => {
            if (res.ok) {
                appendLogLine({
                    time: new Date().toLocaleTimeString(),
                    service: 'system',
                    text: `[Újrafordítás] ${modeLabel} módban elindítva. A logok a konzolon követhetők!`
                });
                scrollToBottom();
            } else {
                const data = await res.json();
                alert(data.message || 'Nem sikerült elindítani a fordítást.');
                setBuildingState(false);
                loadModules();
            }
        })
        .catch(() => {
            alert('Kapcsolódási hiba!');
            setBuildingState(false);
            loadModules();
        });
}

function disableServerControlButtons(disable) {
    const names = ['auth', 'world'];
    names.forEach(name => {
        const btnStart = document.getElementById(`btn-${name}-start`);
        const btnStop = document.getElementById(`btn-${name}-stop`);
        const btnRestart = document.getElementById(`btn-${name}-restart`);
        if (btnStart) btnStart.disabled = disable;
        if (btnStop) btnStop.disabled = disable;
        if (btnRestart) btnRestart.disabled = disable;
    });
}

function setBuildingState(isBuilding) {
    const btnRebuild = document.getElementById('btn-trigger-rebuild');
    const btnMake    = document.getElementById('btn-trigger-make');
    const dot        = document.getElementById('build-status-dot');
    const lbl        = document.getElementById('build-status-lbl');
    const modDot     = document.getElementById('module-status-dot');
    const modLbl     = document.getElementById('module-status-lbl');
    const progBar    = document.getElementById('build-progress-bar-container');

    if (isBuilding) {
        if (btnRebuild) { btnRebuild.disabled = true;  btnRebuild.textContent = 'Fordítás...'; }
        if (btnMake)    { btnMake.disabled    = true;  btnMake.textContent    = 'Fordítás...'; }
        if (dot) dot.className = 'status-dot starting';
        if (lbl) lbl.textContent = 'Fordítás folyamatban';
        if (modDot) modDot.className = 'status-dot starting';
        if (modLbl) modLbl.textContent = 'Fordítás...';
        if (progBar) progBar.classList.remove('hidden');
        disableServerControlButtons(true);
        animateBuildSteps(true);
    } else {
        if (btnRebuild) { btnRebuild.disabled = false; btnRebuild.innerHTML = '🔨 Teljes Újrafordítás (cmake + make)'; }
        if (btnMake)    { btnMake.disabled    = false; btnMake.innerHTML    = '⚡ Csak make install'; }
        if (dot) dot.className = 'status-dot online';
        if (lbl) lbl.textContent = 'Kész';
        if (modDot) modDot.className = 'status-dot online';
        if (modLbl) modLbl.textContent = 'Kész';
        if (progBar) progBar.classList.add('hidden');
        disableServerControlButtons(false);
        animateBuildSteps(false);
        loadModules();
    }
}

let buildStepTimer = null;
function animateBuildSteps(active) {
    const steps = ['bstep-1','bstep-2','bstep-3','bstep-4'];
    steps.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active-step');
    });
    if (buildStepTimer) { clearInterval(buildStepTimer); buildStepTimer = null; }
    if (!active) return;
    let i = 0;
    buildStepTimer = setInterval(() => {
        steps.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active-step');
        });
        const el = document.getElementById(steps[i % steps.length]);
        if (el) el.classList.add('active-step');
        i++;
    }, 4000);
}

function updateRebuildUI(status) {
    // A setBuildingState-et hívjuk SSE-ből is
    const wasBuilding = document.getElementById('btn-trigger-rebuild')?.disabled;
    if (status === 'building' && !wasBuilding) {
        setBuildingState(true);
    } else if (status !== 'building' && wasBuilding) {
        setBuildingState(false);
    }
}
