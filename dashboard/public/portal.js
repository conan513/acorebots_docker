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

// Playermap globals
let currentMap = 'azeroth';
let mapPlayers = [];
let mapImages = {};
let mapCanvas, mapCtx;
let mapTooltip;

const raceNames = {
    1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead',
    6: 'Tauren', 7: 'Gnome', 8: 'Troll', 9: 'Goblin', 10: 'Blood Elf', 11: 'Draenei'
};

const classNames = {
    1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest',
    6: 'Death Knight', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid'
};

const instancesX = {
    azeroth: { 2:0,13:0,17:0,30:762,33:712,34:732,35:732,36:712,37:0,43:245,44:0,47:238,48:172,70:833,90:738,109:849,129:254,150:0,169:0,189:773,209:269,229:782,230:778,249:290,269:315,289:816,309:782,329:834,349:123,369:745,389:308,409:783,429:164,449:741,450:305,451:0,469:778,489:244,509:160,529:820,531:144,532:798,534:317,560:320,568:897,572:750,580:868,585:883,595:322,618:313 },
    outland: { 540:593,542:586,543:593,544:588,545:393,546:399,547:388,548:399,550:683,552:680,553:672,554:669,555:495,556:506,557:495,558:483,559:408,562:443,564:740,565:485 },
    northrend: { 533:568,574:749,575:751,576:161,578:159,599:553,600:605,601:395,602:575,603:559,604:740,608:470,615:491,616:155,617:457,619:400,624:363,631:400,632:415,649:475,650:465,658:393,668:410,724:491 }
};

const instancesY = {
    azeroth: { 2:0,13:0,17:0,30:278,33:295,34:511,35:503,36:567,37:0,43:419,44:0,47:508,48:291,70:443,90:419,109:551,129:516,150:0,169:0,189:216,209:568,229:481,230:484,249:514,269:601,289:258,309:589,329:203,349:432,369:497,389:352,409:484,429:496,449:508,450:352,451:0,469:480,489:364,509:607,529:321,531:603,532:569,534:596,560:606,568:172,572:245,580:26,585:16,595:601,618:348 },
    outland: { 540:399,542:398,543:405,544:402,545:355,546:350,547:353,548:357,550:226,552:215,553:210,554:239,555:569,556:557,557:545,558:557,559:489,562:239,564:567,565:204 },
    northrend: { 533:456,574:577,575:583,576:443,578:451,599:195,600:406,601:462,602:180,603:169,604:292,608:360,615:465,616:447,617:352,619:462,624:369,631:350,632:350,649:207,650:207,658:362,668:365,724:455 }
};

// Coordinate mapping function
function getPlayerPosition(x, y, m) {
    let where530 = 0;
    x = Math.round(x);
    y = Math.round(y);

    if (m === 530) {
        if (y < -1000 && y > -10000 && x > 5000) {
            x = x - 10349;
            y = y + 6357;
            where530 = 1; // BE zone
        } else if (y < -7000 && x < 0) {
            x = x + 3961;
            y = y + 13931;
            where530 = 2; // Draenei zone
        } else {
            x = x - 3070;
            y = y - 1265;
            where530 = 3; // Outland main
        }
    } else if (m === 609) {
        x = x - 2355;
        y = y + 5662;
    }

    let xpos, ypos;
    if (where530 === 3) {
        xpos = Math.round(x * 0.051446);
        ypos = Math.round(y * 0.051446);
    } else if (m === 571) {
        xpos = Math.round(x * 0.050085);
        ypos = Math.round(y * 0.050085);
    } else {
        xpos = Math.round(x * 0.025140);
        ypos = Math.round(y * 0.025140);
    }

    let pos = { x: 0, y: 0 };
    switch (String(m)) {
        case '530':
            if (where530 === 1) {
                pos.x = 858 - ypos;
                pos.y = 84 - xpos;
            } else if (where530 === 2) {
                pos.x = 103 - ypos;
                pos.y = 261 - xpos;
            } else if (where530 === 3) {
                pos.x = 684 - ypos;
                pos.y = 229 - xpos;
            }
            break;
        case '571':
            pos.x = 505 - ypos;
            pos.y = 642 - xpos;
            break;
        case '609':
            pos.x = 896 - ypos;
            pos.y = 232 - xpos;
            break;
        case '1':
            pos.x = 194 - ypos;
            pos.y = 398 - xpos;
            break;
        case '0':
            pos.x = 752 - ypos;
            pos.y = 291 - xpos;
            break;
        default:
            pos.x = 194 - ypos;
            pos.y = 398 - xpos;
    }
    return pos;
}

// Check which map the player belongs to
function getContinentKey(player) {
    if (player.map === 530) {
        // If BE/Dr starting zones, they belong to Azeroth map visually in POMM
        const x = player.x;
        const y = player.y;
        if ((y < -1000 && y > -10000 && x > 5000) || (y < -7000 && x < 0)) {
            return 'azeroth';
        }
        return 'outland';
    } else if (player.map === 571 || instancesX.northrend[player.map] !== undefined) {
        return 'northrend';
    }
    return 'azeroth';
}

function initPlayerMap() {
    mapCanvas = document.getElementById('map-canvas');
    if (!mapCanvas) return;
    mapCtx = mapCanvas.getContext('2d');
    mapTooltip = document.getElementById('map-tooltip');

    // Set canvas internal resolution
    mapCanvas.width = 966;
    mapCanvas.height = 732;

    // Load images
    const imagesToLoad = {
        azeroth: 'map_azeroth.jpg',
        outland: 'map_outland.jpg',
        northrend: 'map_northrend.jpg'
    };

    let loadedCount = 0;
    for (const key in imagesToLoad) {
        mapImages[key] = new Image();
        mapImages[key].onload = () => {
            loadedCount++;
            if (loadedCount === 3) {
                refreshPlayerMap();
            }
        };
        mapImages[key].src = imagesToLoad[key];
    }

    // Set up tab handlers
    document.querySelectorAll('.map-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentMap = tab.getAttribute('data-map');
            renderMap();
        });
    });

    // Tooltip handling
    mapCanvas.addEventListener('mousemove', (e) => {
        const rect = mapCanvas.getBoundingClientRect();
        // Translate mouse coords to canvas internal coords (966x732)
        const scaleX = mapCanvas.width / rect.width;
        const scaleY = mapCanvas.height / rect.height;
        const mouseX = (e.clientX - rect.left) * scaleX;
        const mouseY = (e.clientY - rect.top) * scaleY;

        let activePlayer = null;
        const activeContinentPlayers = getPlayersForContinent(currentMap);

        for (const p of activeContinentPlayers) {
            const pos = getPos(p);
            const dist = Math.hypot(pos.x - mouseX, pos.y - mouseY);
            if (dist < 10) { // Hover radius
                activePlayer = p;
                break;
            }
        }

        if (activePlayer) {
            mapTooltip.classList.remove('hidden');
            mapTooltip.style.left = `${e.clientX - rect.left + 15}px`;
            mapTooltip.style.top = `${e.clientY - rect.top + 15}px`;

            const rName = raceNames[activePlayer.race] || 'Unknown';
            const cName = classNames[activePlayer.class] || 'Unknown';
            const typeText = activePlayer.isBot ? 'Bot' : 'Player';
            
            mapTooltip.innerHTML = `
                <div style="font-weight:bold; color: #fff;">${activePlayer.name}</div>
                <div style="color: var(--gold-primary);">Lvl ${activePlayer.level} ${rName} ${cName}</div>
                <div style="font-size:0.75rem; color: #94a3b8;">${typeText} (${Math.round(activePlayer.x)}, ${Math.round(activePlayer.y)})</div>
            `;
        } else {
            mapTooltip.classList.add('hidden');
        }
    });

    mapCanvas.addEventListener('mouseleave', () => {
        mapTooltip.classList.add('hidden');
    });

    // Auto-refresh loop every 30 seconds
    setInterval(refreshPlayerMap, 30000);
}

function getPlayersForContinent(continent) {
    return mapPlayers.filter(p => getContinentKey(p) === continent);
}

function getPos(player) {
    // If inside an instance
    if (instancesX[currentMap] && instancesX[currentMap][player.map] !== undefined) {
        return {
            x: instancesX[currentMap][player.map],
            y: instancesY[currentMap][player.map]
        };
    }
    return getPlayerPosition(player.x, player.y, player.map);
}

function renderMap() {
    if (!mapCtx || !mapImages[currentMap]) return;

    // Draw background
    mapCtx.drawImage(mapImages[currentMap], 0, 0, mapCanvas.width, mapCanvas.height);

    const activeContinentPlayers = getPlayersForContinent(currentMap);
    const noPlayersEl = document.getElementById('map-no-players');

    if (activeContinentPlayers.length === 0) {
        noPlayersEl.classList.remove('hidden');
    } else {
        noPlayersEl.classList.add('hidden');
    }

    // Draw players
    activeContinentPlayers.forEach(p => {
        const pos = getPos(p);
        
        // Shadow/Glow
        mapCtx.beginPath();
        mapCtx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
        mapCtx.fillStyle = p.isBot ? 'rgba(234, 179, 8, 0.4)' : 'rgba(0, 255, 255, 0.4)';
        mapCtx.fill();

        // Core Dot
        mapCtx.beginPath();
        mapCtx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
        mapCtx.fillStyle = p.isBot ? '#eab308' : '#00ffff';
        mapCtx.fill();

        // Border
        mapCtx.beginPath();
        mapCtx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
        mapCtx.strokeStyle = '#000';
        mapCtx.lineWidth = 1;
        mapCtx.stroke();
    });

    // Render list below
    const listEl = document.getElementById('map-player-list');
    if (listEl) {
        listEl.innerHTML = '';
        if (activeContinentPlayers.length === 0) {
            listEl.innerHTML = '<div style="grid-column: 1/-1; text-align:center; color: var(--text-muted);">No active players or bots on this continent</div>';
        } else {
            activeContinentPlayers.forEach(p => {
                const card = document.createElement('div');
                card.className = 'map-player-card';
                
                const rName = raceNames[p.race] || 'Unknown';
                const cName = classNames[p.class] || 'Unknown';
                const typeClass = p.isBot ? 'bot' : 'player';
                const typeText = p.isBot ? 'Bot' : 'Player';

                card.innerHTML = `
                    <div class="map-player-info">
                        <span class="map-player-name">${p.name}</span>
                        <span class="map-player-details">Lvl ${p.level} ${rName} ${cName}</span>
                    </div>
                    <span class="map-player-type ${typeClass}">${typeText}</span>
                `;
                listEl.appendChild(card);
            });
        }
    }
}

function refreshPlayerMap() {
    const refreshBtn = document.getElementById('map-refresh-btn');
    if (refreshBtn) refreshBtn.disabled = true;

    fetch('/api/playermap')
        .then(res => res.json())
        .then(data => {
            mapPlayers = data;
            renderMap();
            document.getElementById('map-last-update').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
        })
        .catch(err => {
            console.error('Error fetching playermap data:', err);
            document.getElementById('map-last-update').textContent = 'Error updating!';
        })
        .finally(() => {
            if (refreshBtn) refreshBtn.disabled = false;
        });
}

// Initialization when the page loads
window.addEventListener('DOMContentLoaded', () => {
    // Set default realmlist value based on hostname
    const hostname = window.location.hostname;
    document.getElementById('realmlist-text').value = `set realmlist ${hostname}`;
    
    initStatusStream();
    initPlayerMap();
});

