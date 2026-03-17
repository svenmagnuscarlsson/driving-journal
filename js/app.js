console.log("Körjournal startad");

// ─── Grundläggande referenser ───────────────────────────────────────────────
const toggleBtn       = document.getElementById('toggle-btn');
const timeDisplay     = document.getElementById('current-time');
const distanceDisplay = document.getElementById('current-distance');
const speedDisplay    = document.getElementById('current-speed');
const tripList        = document.getElementById('trip-list');
const dimmerOverlay   = document.getElementById('dimmer-overlay');
const mergeModal      = document.getElementById('merge-modal');
const mergeNameInput  = document.getElementById('merge-name-input');
const mergeCancelBtn  = document.getElementById('merge-cancel-btn');
const mergeSaveBtn    = document.getElementById('merge-save-btn');

let isRunning    = false;
let startTime    = null;
let timerInterval = null;
let watchId      = null;
let totalDistance = 0;
let lastPosition = null;
let wakeLock     = null;
let draggedTripId = null;
let mergeTargetId = null;

// ─── Kalman-filter state ─────────────────────────────────────────────────────
// En enkel 1D Kalman-filter per koordinat
let kalman = null;

function initKalman(lat, lon, accuracy) {
    return {
        lat,
        lon,
        // Processvariation (rörelseosäkerhet) – högre värde = mer responsivt i kurvor
        Q: 1e-5,
        // Mätosäkerhet (konverteras från meter till grader ~1°≈111km)
        R: Math.pow(accuracy / 111000, 2),
        // Estimatets kovarians
        P_lat: Math.pow(accuracy / 111000, 2),
        P_lon: Math.pow(accuracy / 111000, 2),
    };
}

function kalmanUpdate(state, newLat, newLon, accuracy) {
    const R = Math.pow(Math.max(accuracy, 1) / 111000, 2);

    // Uppdatera Kalman-gain och estimat för latitud
    const K_lat  = state.P_lat / (state.P_lat + R);
    state.lat    = state.lat + K_lat * (newLat - state.lat);
    state.P_lat  = (1 - K_lat) * state.P_lat + state.Q;

    // Uppdatera Kalman-gain och estimat för longitud
    const K_lon  = state.P_lon / (state.P_lon + R);
    state.lon    = state.lon + K_lon * (newLon - state.lon);
    state.P_lon  = (1 - K_lon) * state.P_lon + state.Q;

    return { lat: state.lat, lon: state.lon };
}

// ─── Vincenty-formeln (WGS-84 ellipsoid) ─────────────────────────────────────
// Ger precision ner till ~0,5 mm, till skillnad från Haversine (~0,3% fel)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const a  = 6378137.0;          // Semi-major axis (m)
    const f  = 1 / 298.257223563;  // Tillplattning
    const b  = (1 - f) * a;        // Semi-minor axis (m)

    const toRad = deg => deg * Math.PI / 180;

    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const L  = toRad(lon2 - lon1);

    const U1 = Math.atan((1 - f) * Math.tan(φ1));
    const U2 = Math.atan((1 - f) * Math.tan(φ2));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let λ = L, λPrev, iterLimit = 100;
    let sinλ, cosλ, sinσ, cosσ, σ, sinα, cosSqα, cos2σm, C;

    do {
        sinλ   = Math.sin(λ);
        cosλ   = Math.cos(λ);
        sinσ   = Math.sqrt(
            Math.pow(cosU2 * sinλ, 2) +
            Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosλ, 2)
        );

        if (sinσ === 0) return 0; // Sammanfallande punkter

        cosσ   = sinU1 * sinU2 + cosU1 * cosU2 * cosλ;
        σ      = Math.atan2(sinσ, cosσ);
        sinα   = (cosU1 * cosU2 * sinλ) / sinσ;
        cosSqα = 1 - sinα * sinα;
        cos2σm = cosSqα !== 0 ? cosσ - (2 * sinU1 * sinU2) / cosSqα : 0;
        C      = (f / 16) * cosSqα * (4 + f * (4 - 3 * cosSqα));
        λPrev  = λ;
        λ = L + (1 - C) * f * sinα * (
            σ + C * sinσ * (cos2σm + C * cosσ * (-1 + 2 * cos2σm * cos2σm))
        );
    } while (Math.abs(λ - λPrev) > 1e-12 && --iterLimit > 0);

    if (iterLimit === 0) {
        // Vincenty konvergerade inte (antipodala punkter) – fall tillbaka på Haversine
        return haversine(lat1, lon1, lat2, lon2);
    }

    const uSq  = cosSqα * (a * a - b * b) / (b * b);
    const A_v  = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B_v  = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const Δσ   = B_v * sinσ * (
        cos2σm + (B_v / 4) * (
            cosσ * (-1 + 2 * cos2σm * cos2σm) -
            (B_v / 6) * cos2σm * (-3 + 4 * sinσ * sinσ) * (-3 + 4 * cos2σm * cos2σm)
        )
    );

    const dist = b * A_v * (σ - Δσ); // Distans i meter
    return dist / 1000;               // Returnera i km
}

// Haversine som backup
function haversine(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GPS-hanterare ────────────────────────────────────────────────────────────
function handlePosition(position) {
    const { latitude, longitude, accuracy, speed } = position.coords;

    // 1. Kasta bort mätningar med för dålig noggrannhet (>50m = opålitligt)
    if (accuracy > 50) {
        console.warn(`GPS ignoreras – noggrannhet ${accuracy.toFixed(0)}m (>50m)`);
        return;
    }

    // 2. Initiera eller uppdatera Kalman-filter
    if (!kalman) {
        kalman = initKalman(latitude, longitude, accuracy);
    }
    const filtered = kalmanUpdate(kalman, latitude, longitude, accuracy);

    // 3. Stillaståndsfiltrering: om GPS-hastigheten är < 2 km/h, räkna som stilla
    //    (Undviker att GPS-drift vid rödljus ackumuleras)
    const speedKmh = (speed !== null && speed !== undefined) ? speed * 3.6 : null;
    const isStationary = speedKmh !== null && speedKmh < 2.0;

    let distanceCounted = false;

    if (lastPosition && !isStationary) {
        const dist = calculateDistance(
            lastPosition.latitude, lastPosition.longitude,
            filtered.lat, filtered.lon
        );

        // 4. Dynamisk tröskel: kräv rimlig rörelse relativt noggrannheten
        //    Lägre tröskel (accuracy * 0.5, min 3m) för att inte tappa sträcka
        const minDistKm = Math.max(accuracy * 0.5, 3) / 1000;

        if (dist >= minDistKm) {
            // 5. Rimlighetskontroll: max 200 km/h → max rörelse per sekund
            const timeDiffSec = (Date.now() - lastPosition.timestamp) / 1000;
            const impliedSpeedKmh = dist / (timeDiffSec / 3600);
            if (impliedSpeedKmh < 200) {
                totalDistance += dist;
                distanceDisplay.textContent = totalDistance.toFixed(2);
                distanceCounted = true;
            } else {
                console.warn(`Orealistiskt hopp ignoreras: ${impliedSpeedKmh.toFixed(0)} km/h`);
            }
        }

        // Beräkna fallback-hastighet om GPS inte ger speed
        if (speedKmh === null) {
            const timeDiffH = (Date.now() - lastPosition.timestamp) / 3600000;
            if (timeDiffH > 0 && dist > 0.005) {
                const calcSpeed = Math.round(dist / timeDiffH);
                if (calcSpeed < 200) speedDisplay.textContent = calcSpeed;
            }
        }
    }

    // Visa hastighet
    if (speedKmh !== null) {
        speedDisplay.textContent = isStationary ? 0 : Math.round(speedKmh);
    } else if (!lastPosition) {
        speedDisplay.textContent = '0';
    }

    // KRITISKT: Uppdatera lastPosition BARA när sträckan faktiskt räknades,
    // eller vid första mätningen. Annars förloras små rörelser permanent.
    if (distanceCounted || !lastPosition) {
        lastPosition = {
            latitude:  filtered.lat,
            longitude: filtered.lon,
            timestamp: Date.now()
        };
    }

    console.log(
        `GPS: ${filtered.lat.toFixed(6)}, ${filtered.lon.toFixed(6)} ` +
        `| Noggr: ${accuracy.toFixed(0)}m | Hastighet: ${speedKmh !== null ? speedKmh.toFixed(1) : '–'} km/h`
    );
}

function handleError(error) {
    console.warn(`GPS Fel (${error.code}): ${error.message}`);
}

// ─── Starta / Stoppa resa ─────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
    if (!isRunning) {
        startTrip();
    } else {
        stopTrip();
    }
});

function startTrip() {
    isRunning     = true;
    startTime     = Date.now();
    totalDistance = 0;
    lastPosition  = null;
    kalman        = null;
    speedDisplay.textContent = '0';

    toggleBtn.textContent = 'STOPPA';
    toggleBtn.classList.replace('start', 'stop');

    timerInterval = setInterval(updateTimer, 1000);

    if ("geolocation" in navigator) {
        watchId = navigator.geolocation.watchPosition(
            handlePosition,
            handleError,
            {
                enableHighAccuracy: true,
                timeout: 15000,    // Längre timeout → fler positioner i svåra miljöer
                maximumAge: 0      // Aldrig cachade positioner
            }
        );
    } else {
        alert("GPS stöds inte i denna webbläsare.");
    }

    requestWakeLock();
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log("Wake Lock aktivt");
            wakeLock.addEventListener('release', () => {
                console.log("Wake Lock släppt");
            });
        }
    } catch (err) {
        console.warn(`${err.name}, ${err.message}`);
    }
}

function stopTrip() {
    isRunning = false;
    clearInterval(timerInterval);
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    speedDisplay.textContent = '0';
    kalman = null;

    if (wakeLock !== null) {
        wakeLock.release();
        wakeLock = null;
    }

    toggleBtn.textContent = 'STARTA';
    toggleBtn.classList.replace('stop', 'start');

    saveTrip();
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function updateTimer() {
    const elapsed = Date.now() - startTime;
    const hours   = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
    const minutes = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
    const seconds = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
    timeDisplay.textContent = `${hours}:${minutes}:${seconds}`;
}

// ─── Spara resa ───────────────────────────────────────────────────────────────
function saveTrip() {
    const startObj  = new Date(startTime);
    const endObj    = new Date();
    const startClock = startObj.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const endClock   = endObj.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

    const trip = {
        date:       new Date().toLocaleDateString('sv-SE'),
        time:       timeDisplay.textContent,
        distance:   distanceDisplay.textContent,
        timestamp:  Date.now(),
        startClock,
        endClock
    };

    const trips = JSON.parse(localStorage.getItem('trips') || '[]');
    trips.unshift(trip);
    localStorage.setItem('trips', JSON.stringify(trips));

    renderTrips(trip.timestamp);
}

// ─── Rendera reselista ────────────────────────────────────────────────────────
function renderTrips(newItemTimestamp = null) {
    const trips = JSON.parse(localStorage.getItem('trips') || '[]');
    tripList.innerHTML = trips.map(t => {
        const spanTime       = (t.startClock && t.endClock) ? ` kl ${t.startClock}-${t.endClock}` : '';
        const animationClass = t.timestamp === newItemTimestamp ? ' animate-in' : '';
        const displayName    = t.name ? `<strong>${t.name}</strong><br><small>${t.date}${spanTime}</small>` : `<strong>${t.date}${spanTime}</strong>`;
        
        return `
        <li class="trip-item${animationClass}" draggable="true" data-timestamp="${t.timestamp}">
            <div class="trip-info">
                ${displayName}<br>
                <small>${t.time}</small>
            </div>
            <div class="trip-dist-container">
                <div class="trip-dist">${t.distance} km</div>
                <button class="delete-btn" data-timestamp="${t.timestamp}" title="Ta bort resa">×</button>
            </div>
        </li>
        `;
    }).join('');
}

function deleteTrip(timestamp) {
    if (confirm("Vill du ta bort denna resa?")) {
        const trips = JSON.parse(localStorage.getItem('trips') || '[]');
        const updatedTrips = trips.filter(t => t.timestamp !== parseInt(timestamp));
        localStorage.setItem('trips', JSON.stringify(updatedTrips));
        renderTrips();
    }
}

// ─── Händelselyssnare ─────────────────────────────────────────────────────────
tripList.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete-btn')) {
        deleteTrip(e.target.getAttribute('data-timestamp'));
    }
});

// Drag and Drop
tripList.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.trip-item');
    if (item) {
        draggedTripId = parseInt(item.getAttribute('data-timestamp'));
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }
});

tripList.addEventListener('dragend', (e) => {
    const item = e.target.closest('.trip-item');
    if (item) item.classList.remove('dragging');
    document.querySelectorAll('.trip-item').forEach(i => i.classList.remove('drag-over'));
});

tripList.addEventListener('dragover', (e) => {
    e.preventDefault();
    const item = e.target.closest('.trip-item');
    if (item && draggedTripId && parseInt(item.getAttribute('data-timestamp')) !== draggedTripId) {
        item.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'move';
    }
});

tripList.addEventListener('dragleave', (e) => {
    const item = e.target.closest('.trip-item');
    if (item) item.classList.remove('drag-over');
});

tripList.addEventListener('drop', (e) => {
    e.preventDefault();
    const item = e.target.closest('.trip-item');
    if (item && draggedTripId) {
        mergeTargetId = parseInt(item.getAttribute('data-timestamp'));
        if (mergeTargetId !== draggedTripId) {
            showMergeModal();
        }
    }
});

// Modal events
mergeCancelBtn.addEventListener('click', hideMergeModal);
mergeSaveBtn.addEventListener('click', handleMergeSave);
mergeNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleMergeSave();
});

function handleMergeSave() {
    const name = mergeNameInput.value.trim();
    if (name) {
        executeMerge(name);
    } else {
        alert("Vänligen ange ett namn för resan.");
    }
}

function showMergeModal() {
    mergeModal.classList.remove('hidden');
    mergeNameInput.value = '';
    mergeNameInput.focus();
}

function hideMergeModal() {
    mergeModal.classList.add('hidden');
    draggedTripId = null;
    mergeTargetId = null;
}

function executeMerge(name) {
    const trips = JSON.parse(localStorage.getItem('trips') || '[]');
    const t1 = trips.find(t => t.timestamp === draggedTripId);
    const t2 = trips.find(t => t.timestamp === mergeTargetId);

    if (!t1 || !t2) return;

    // Beräkna ny distans
    const totalDist = (parseFloat(t1.distance) + parseFloat(t2.distance)).toFixed(2);

    // Beräkna ny tid
    const totalSeconds = timeToSeconds(t1.time) + timeToSeconds(t2.time);
    const totalDuration = secondsToTime(totalSeconds);

    // Hantera datum och klockslag (sortera efter timestamp)
    const sorted = [t1, t2].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const mergedDate = first.date === last.date ? first.date : `${first.date} - ${last.date}`;
    
    const mergedTrip = {
        name: name,
        date: mergedDate,
        time: totalDuration,
        distance: totalDist,
        timestamp: Date.now(),
        startClock: first.startClock,
        endClock: last.endClock
    };

    // Uppdatera listan
    const updatedTrips = trips.filter(t => t.timestamp !== draggedTripId && t.timestamp !== mergeTargetId);
    updatedTrips.unshift(mergedTrip);
    localStorage.setItem('trips', JSON.stringify(updatedTrips));

    hideMergeModal();
    renderTrips(mergedTrip.timestamp);
}

function timeToSeconds(timeStr) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function secondsToTime(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

// Återansök Wake Lock vid flikbyte
document.addEventListener('visibilitychange', async () => {
    if (isRunning && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

// ─── Initiering ───────────────────────────────────────────────────────────────
renderTrips();
