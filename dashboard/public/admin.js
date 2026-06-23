let currentFilter = 'all';
let commandHistory = [];
let historyIndex = -1;
let sseSource = null;

// Initial check on load
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

    // Add module form submit
    const addModuleForm = document.getElementById('add-module-form');
    if (addModuleForm) {
        addModuleForm.addEventListener('submit', (e) => {
            e.preventDefault();
            addModule();
        });
    }
});

// Check authentication
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
        title.textContent = 'First Start: Admin Password';
        desc.textContent = 'Provide a secure administrator password for the server dashboard.';
        loginFm.classList.add('hidden');
        setupFm.classList.remove('hidden');
    } else {
        title.textContent = 'Administrator Login';
        desc.textContent = 'Enter the administrator password to manage the server.';
        loginFm.classList.remove('hidden');
        setupFm.classList.add('hidden');
    }
}

// Save first-start password
function setupPassword() {
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-password-confirm').value;
    const messageBox = document.getElementById('login-message');
    const submitBtn = document.getElementById('btn-setup');

    messageBox.classList.add('hidden');

    if (password !== confirm) {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'The passwords do not match!';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

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
            messageBox.textContent = data.message || 'An error occurred during save!';
        }
    })
    .catch(() => {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'Connection error!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save & Login';
    });
}

function showAdminPanel() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-content').classList.remove('hidden');
    initAdminStream();
    loadModules();
}

// Login
function login() {
    const password = document.getElementById('admin-password').value;
    const messageBox = document.getElementById('login-message');
    const submitBtn = document.getElementById('btn-login');

    messageBox.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in...';

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
            messageBox.textContent = data.message || 'Failed login!';
        }
    })
    .catch(() => {
        messageBox.classList.remove('hidden');
        messageBox.textContent = 'Server connection error!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Login';
    });
}

// Logout
function logout() {
    fetch('/api/admin/logout', { method: 'POST' })
        .then(() => {
            showLoginOverlay();
        });
}

// Initialize SSE Connection
function initAdminStream() {
    if (sseSource) {
        sseSource.close();
    }

    const term = document.getElementById('terminal-output');
    term.innerHTML = '<div class="terminal-line system-msg">[System] Establishing connection...</div>';

    sseSource = new EventSource('/api/status-stream');

    // Stats event (Server statuses, CPU, RAM)
    sseSource.addEventListener('stats', (event) => {
        const stats = JSON.parse(event.data);
        updateProcessUI('mysql', stats.mysql);
        updateProcessUI('authserver', stats.authserver);
        updateProcessUI('worldserver', stats.worldserver);
        
        // Synchronize module rebuild status
        updateRebuildUI(stats.rebuildStatus);
    });

    // Receive initial log history
    sseSource.addEventListener('history', (event) => {
        const history = JSON.parse(event.data);
        term.innerHTML = ''; // Clear connection msgs
        history.forEach(log => {
            appendLogLine(log);
        });
        scrollToBottom();
    });

    // Receive new log line
    sseSource.addEventListener('log', (event) => {
        const log = JSON.parse(event.data);
        appendLogLine(log);
        scrollToBottom();
    });

    sseSource.onerror = () => {
        const line = document.createElement('div');
        line.className = 'terminal-line system-msg';
        line.textContent = '[System] Error in log stream. Reconnecting...';
        term.appendChild(line);
        scrollToBottom();
    };
}

// Update process card UI
function updateProcessUI(name, info) {
    const card = document.getElementById(`card-${name}`);
    if (!card) return;

    // Status borders & lights
    const dot = card.querySelector('.status-dot');
    const lbl = card.querySelector('.status-lbl');
    
    dot.className = `status-dot ${info.status}`;
    
    let statusText = 'Offline';
    if (info.status === 'running') statusText = 'Running';
    if (info.status === 'starting') statusText = 'Starting';
    lbl.textContent = statusText;

    // CPU and RAM
    const cpuBar = document.getElementById(`${name}-cpu-bar`);
    const cpuVal = document.getElementById(`${name}-cpu-val`);
    const ramVal = document.getElementById(`${name}-ram-val`);

    if (cpuBar) cpuBar.style.width = `${Math.min(info.cpu, 100)}%`;
    if (cpuVal) cpuVal.textContent = `${info.cpu.toFixed(1)}%`;
    if (ramVal) ramVal.textContent = `${info.ram} MB`;

    // Button states
    if (name !== 'mysql') {
        const btnStart = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-start`);
        const btnStop = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-stop`);
        const btnRestart = document.getElementById(`btn-${name === 'authserver' ? 'auth' : 'world'}-restart`);

        if (info.status === 'running') {
            btnStart.disabled = true;
            btnStop.disabled = false;
            btnRestart.disabled = false;
            
            // If worldserver is running, enable console input
            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = false;
                document.getElementById('btn-send-command').disabled = false;
                document.getElementById('console-input').placeholder = "Enter a GM command (e.g. .server info or .reload all) and press Enter...";
            }
        } else if (info.status === 'starting') {
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnRestart.disabled = true;
            
            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = true;
                document.getElementById('btn-send-command').disabled = true;
                document.getElementById('console-input').placeholder = "Worldserver starting. Please wait...";
            }
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;
            btnRestart.disabled = true;

            if (name === 'worldserver') {
                document.getElementById('console-input').disabled = true;
                document.getElementById('btn-send-command').disabled = true;
                document.getElementById('console-input').placeholder = "Start Worldserver to use the console!";
            }
        }
    }
}

// Add log line to terminal
function appendLogLine(log) {
    const term = document.getElementById('terminal-output');
    
    // Safety limit: maximum 1000 lines can remain in the DOM
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

    // Add timestamp if present
    const timeStr = log.time ? `[${log.time}] ` : '';
    const prefix = log.service === 'world' ? '[World] ' : 
                   log.service === 'auth' ? '[Auth] ' : 
                   log.service === 'compiler' ? '[Compiler] ' : '';
                   
    line.textContent = `${timeStr}${prefix}${log.text}`;

    // Apply filter to the new line
    applyLineFilter(line);

    term.appendChild(line);
}

// Filter log lines
function filterLogs(filterType) {
    currentFilter = filterType;
    
    // Button status
    document.getElementById('filter-all').className = `filter-btn ${filterType === 'all' ? 'active' : ''}`;
    document.getElementById('filter-world').className = `filter-btn ${filterType === 'world' ? 'active' : ''}`;
    document.getElementById('filter-auth').className = `filter-btn ${filterType === 'auth' ? 'active' : ''}`;

    // Hide/show lines
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

// Scroll to the bottom of the terminal
function scrollToBottom() {
    const term = document.getElementById('terminal-output');
    term.scrollTop = term.scrollHeight;
}

// Send console command
function sendConsoleCommand() {
    const input = document.getElementById('console-input');
    const command = input.value.trim();
    if (!command) return;

    // Save in history
    commandHistory.push(command);
    if (commandHistory.length > 50) {
        commandHistory.shift();
    }
    historyIndex = -1;

    // Immediate local feedback in terminal
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
                text: '[System] Failed to send command (server error).'
            });
            scrollToBottom();
        }
    })
    .catch(() => {
        appendLogLine({
            time: new Date().toLocaleTimeString(),
            service: 'system',
            text: '[System] Failed to reach the server.'
        });
        scrollToBottom();
    });
}

// Quick command
function sendQuickCommand(cmd) {
    const input = document.getElementById('console-input');
    if (input.disabled) return;
    
    input.value = cmd;
    input.focus();
    
    // If complete command, send immediately
    if (cmd !== '.account create ') {
        sendConsoleCommand();
    }
}

// Start / stop / restart process
function controlProcess(service, action) {
    const btnStart = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-start`);
    const btnStop = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-stop`);
    const btnRestart = document.getElementById(`btn-${service === 'authserver' ? 'auth' : 'world'}-restart`);

    // Temporarily disable buttons
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    if (btnRestart) btnRestart.disabled = true;

    appendLogLine({
        time: new Date().toLocaleTimeString(),
        service: 'system',
        text: `[System] Sending ${service} control request: ${action}...`
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
                text: `[System] Error occurred: ${data.message || 'Unknown error'}`
            });
            scrollToBottom();
        }
    })
    .catch(() => {
        appendLogLine({
            time: new Date().toLocaleTimeString(),
            service: 'system',
            text: `[System] Failed to connect to the controller.`
        });
        scrollToBottom();
    });
}

// ==========================================================================
// C++ Module Manager & Build Logic
// ==========================================================================

// Load modules from server
function loadModules() {
    const list = document.getElementById('module-list');
    if (!list) return;

    fetch('/api/admin/modules')
        .then(res => res.json())
        .then(data => {
            list.innerHTML = '';
            if (!data.modules || data.modules.length === 0) {
                list.innerHTML = '<li class="module-item loading">No custom modules installed.</li>';
            } else {
                data.modules.forEach(mod => {
                    const li = document.createElement('li');
                    li.className = 'module-item';
                    
                    const name = getModuleName(mod);
                    li.innerHTML = `
                        <span class="module-url" title="${mod}">${name}</span>
                        <button onclick="deleteModule('${mod}')" class="delete-module-btn" title="Delete">&times;</button>
                    `;
                    list.appendChild(li);
                });
            }

            // Rebuild warning
            const warningBox = document.getElementById('rebuild-warning-box');
            if (data.rebuildRequired) {
                warningBox.classList.remove('hidden');
            } else {
                warningBox.classList.add('hidden');
            }
        })
        .catch(() => {
            list.innerHTML = '<li class="module-item loading error">Error fetching modules!</li>';
        });
}

// Extract module name from Git URL
function getModuleName(url) {
    if (!url) return '';
    const parts = url.split('/');
    let last = parts[parts.length - 1];
    if (last.endsWith('.git')) {
        last = last.substring(0, last.length - 4);
    }
    return last;
}

// Add new module
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
            alert(data.message || 'Error adding module!');
        }
    })
    .catch(() => {
        alert('Server connection error!');
    })
    .finally(() => {
        input.disabled = false;
    });
}

// Delete module
function deleteModule(url) {
    if (!confirm(`Are you sure you want to remove the module "${getModuleName(url)}"?`)) return;

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
            alert(data.message || 'Error deleting module!');
        }
    })
    .catch(() => {
        alert('Server connection error!');
    });
}

// Trigger rebuild
function triggerRebuild(mode) {
    mode = mode || 'full';
    const modeLabel = mode === 'make-only' ? 'make install (without cmake)' : 'full (cmake + make)';
    if (!confirm(`Warning: Recompiling the server (${modeLabel}) will stop the game and may take 10-20 minutes. Start?`)) return;

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
                    text: `[Rebuild] Started in ${modeLabel} mode. Logs can be followed in the console!`
                });
                scrollToBottom();
            } else {
                const data = await res.json();
                alert(data.message || 'Failed to start compilation.');
                setBuildingState(false);
                loadModules();
            }
        })
        .catch(() => {
            alert('Connection error!');
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
        if (btnRebuild) { btnRebuild.disabled = true;  btnRebuild.textContent = 'Compiling...'; }
        if (btnMake)    { btnMake.disabled    = true;  btnMake.textContent    = 'Compiling...'; }
        if (dot) dot.className = 'status-dot starting';
        if (lbl) lbl.textContent = 'Compilation in progress';
        if (modDot) modDot.className = 'status-dot starting';
        if (modLbl) modLbl.textContent = 'Compiling...';
        if (progBar) progBar.classList.remove('hidden');
        disableServerControlButtons(true);
        animateBuildSteps(true);
    } else {
        if (btnRebuild) { btnRebuild.disabled = false; btnRebuild.innerHTML = '🔨 Full Recompilation (cmake + make)'; }
        if (btnMake)    { btnMake.disabled    = false; btnMake.innerHTML    = '⚡ Only make install'; }
        if (dot) dot.className = 'status-dot online';
        if (lbl) lbl.textContent = 'Ready';
        if (modDot) modDot.className = 'status-dot online';
        if (modLbl) modLbl.textContent = 'Ready';
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

// Call setBuildingState from SSE as well
function updateRebuildUI(status) {
    const wasBuilding = document.getElementById('btn-trigger-rebuild')?.disabled;
    if (status === 'building' && !wasBuilding) {
        setBuildingState(true);
    } else if (status !== 'building' && wasBuilding) {
        setBuildingState(false);
    }
}
