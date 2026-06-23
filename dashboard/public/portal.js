// Connection to server SSE stream to display the status
function initStatusStream() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const serverUptime = document.getElementById('server-uptime');
    const activePlayers = document.getElementById('active-players');

    // Use EventSource API for real-time communication
    const source = new EventSource('/api/status-stream');

    source.addEventListener('stats', (event) => {
        const stats = JSON.parse(event.data);
        
        // Get Worldserver status
        const world = stats.worldserver;
        if (world.status === 'running') {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'ONLINE';
            
            // Format uptime
            if (world.uptime) {
                serverUptime.textContent = formatUptime(world.uptime);
            } else {
                serverUptime.textContent = 'Active';
            }
        } else if (world.status === 'starting') {
            statusDot.className = 'status-dot starting';
            statusText.textContent = 'STARTING';
            serverUptime.textContent = 'Starting...';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'OFFLINE';
            serverUptime.textContent = 'Offline';
            activePlayers.textContent = '0';
        }

        // Update active players count (if available)
        if (world.status === 'running' && stats.playerCount !== undefined) {
            activePlayers.textContent = stats.playerCount;
        }
    });

    source.onerror = (err) => {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'OFFLINE (Connection Error)';
        serverUptime.textContent = 'Error';
        activePlayers.textContent = '0';
    };
}

// Uptime formatting helper function
function formatUptime(seconds) {
    if (!seconds) return '0 s';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    let res = '';
    if (d > 0) res += `${d}d `;
    if (h > 0 || d > 0) res += `${h}h `;
    if (m > 0 || h > 0 || d > 0) res += `${m}m `;
    res += `${s}s`;
    return res;
}

// Copy to clipboard
function copyRealmlist() {
    const copyText = document.getElementById('realmlist-text');
    const copyBtn = document.getElementById('btn-copy');
    
    copyText.select();
    copyText.setSelectionRange(0, 99999); // For mobile devices
    
    navigator.clipboard.writeText(copyText.value)
        .then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            copyBtn.style.borderColor = '#10b981';
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.style.borderColor = '';
            }, 2000);
        })
        .catch(err => {
            console.error('Failed to copy: ', err);
        });
}

// Handle registration
document.getElementById('register-form').addEventListener('submit', function (e) {
    e.preventDefault();

    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirmPassword = document.getElementById('reg-confirm-password').value;
    const messageBox = document.getElementById('register-message');
    const submitBtn = document.getElementById('btn-register');

    // Reset UI message
    messageBox.className = 'message-box hidden';
    messageBox.textContent = '';

    // Validation
    if (password !== confirmPassword) {
        messageBox.className = 'message-box error';
        messageBox.textContent = 'The passwords do not match!';
        return;
    }

    // Disable button during submit
    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering...';

    // POST request to the server
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
            messageBox.textContent = 'Account successfully created! Have fun!';
            document.getElementById('register-form').reset();
        } else {
            messageBox.className = 'message-box error';
            messageBox.textContent = data.message || 'An error occurred during registration.';
        }
    })
    .catch((err) => {
        messageBox.className = 'message-box error';
        messageBox.textContent = 'Failed to reach the registration server. Please try again later!';
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
    });
});

// Initialization when the page loads
window.addEventListener('DOMContentLoaded', () => {
    // Set default realmlist value based on hostname
    const hostname = window.location.hostname;
    document.getElementById('realmlist-text').value = `set realmlist ${hostname}`;
    
    initStatusStream();
});
