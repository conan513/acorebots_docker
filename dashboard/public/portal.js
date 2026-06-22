// Csatlakozás a szerver SSE folyamatához az állapot kijelzésére
function initStatusStream() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const serverUptime = document.getElementById('server-uptime');
    const activePlayers = document.getElementById('active-players');

    // Használjuk az EventSource API-t a valós idejű kommunikációhoz
    const source = new EventSource('/api/status-stream');

    source.addEventListener('stats', (event) => {
        const stats = JSON.parse(event.data);
        
        // Worldserver állapot lekérése
        const world = stats.worldserver;
        if (world.status === 'running') {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'ONLINE';
            
            // Format uptime
            if (world.uptime) {
                serverUptime.textContent = formatUptime(world.uptime);
            } else {
                serverUptime.textContent = 'Aktív';
            }
        } else if (world.status === 'starting') {
            statusDot.className = 'status-dot starting';
            statusText.textContent = 'INDÍTÁS ALATT';
            serverUptime.textContent = 'Indul...';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'OFFLINE';
            serverUptime.textContent = 'Offline';
            activePlayers.textContent = '0';
        }

        // Aktív játékosok számának frissítése (ha van ilyen adat)
        if (world.status === 'running' && stats.playerCount !== undefined) {
            activePlayers.textContent = stats.playerCount;
        }
    });

    source.onerror = (err) => {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'OFFLINE (Kapcsolati Hiba)';
        serverUptime.textContent = 'Hiba';
        activePlayers.textContent = '0';
    };
}

// Uptime formázó segédfüggvény
function formatUptime(seconds) {
    if (!seconds) return '0 mp';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    let res = '';
    if (d > 0) res += `${d} nap `;
    if (h > 0 || d > 0) res += `${h} óra `;
    if (m > 0 || h > 0 || d > 0) res += `${m} perc `;
    res += `${s} mp`;
    return res;
}

// Másolás vágólapra
function copyRealmlist() {
    const copyText = document.getElementById('realmlist-text');
    const copyBtn = document.getElementById('btn-copy');
    
    copyText.select();
    copyText.setSelectionRange(0, 99999); // Mobil eszközökhöz
    
    navigator.clipboard.writeText(copyText.value)
        .then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = 'Másolva!';
            copyBtn.style.borderColor = '#10b981';
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.style.borderColor = '';
            }, 2000);
        })
        .catch(err => {
            console.error('Nem sikerült a másolás: ', err);
        });
}

// Regisztráció kezelése
document.getElementById('register-form').addEventListener('submit', function (e) {
    e.preventDefault();

    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirmPassword = document.getElementById('reg-confirm-password').value;
    const messageBox = document.getElementById('register-message');
    const submitBtn = document.getElementById('btn-register');

    // UI üzenet alaphelyzetbe
    messageBox.className = 'message-box hidden';
    messageBox.textContent = '';

    // Validáció
    if (password !== confirmPassword) {
        messageBox.className = 'message-box error';
        messageBox.textContent = 'A megadott jelszavak nem egyeznek!';
        return;
    }

    // Gomb letiltása küldés alatt
    submitBtn.disabled = true;
    submitBtn.textContent = 'Regisztráció...';

    // POST kérés a szervernek
    fetch('/api/register', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
    })
    .then(async (res) => {
        const data = await res.json();
        if (res.ok) {
            messageBox.className = 'message-box success';
            messageBox.textContent = 'Fiók sikeresen létrehozva! Jó játékot!';
            document.getElementById('register-form').reset();
        } else {
            messageBox.className = 'message-box error';
            messageBox.textContent = data.message || 'Hiba történt a regisztráció során.';
        }
    })
    .catch((err) => {
        messageBox.className = 'message-box error';
        messageBox.textContent = 'Nem sikerült elérni a regisztrációs szervert. Próbáld újra később!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Fiók Létrehozása';
    });
});

// Inicializálás az oldal betöltődésekor
window.addEventListener('DOMContentLoaded', () => {
    // Beállítjuk a realmlist alapértelmezett értéket a hosztnév alapján
    const hostname = window.location.hostname;
    document.getElementById('realmlist-text').value = `set realmlist ${hostname}`;
    
    initStatusStream();
});
