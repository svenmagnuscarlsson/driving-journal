console.log("Körjournal startad");

// Grundläggande referenser
const toggleBtn = document.getElementById('toggle-btn');
const timeDisplay = document.getElementById('current-time');
const distanceDisplay = document.getElementById('current-distance');
const tripList = document.getElementById('trip-list');
const dimmerOverlay = document.getElementById('dimmer-overlay');

let isRunning = false;
let startTime = null;
let timerInterval = null;
let watchId = null;
let totalDistance = 0;
let lastPosition = null;
let wakeLock = null;

toggleBtn.addEventListener('click', () => {
    if (!isRunning) {
        startTrip();
    } else {
        stopTrip();
    }
});

function startTrip() {
    isRunning = true;
    startTime = Date.now();
    totalDistance = 0;
    lastPosition = null;

    // UI Uppdatering
    toggleBtn.textContent = 'STOPPA';
    toggleBtn.classList.replace('start', 'stop');
    dimmerOverlay.classList.remove('hidden');
    dimmerOverlay.classList.add('active');

    // Starta timer
    timerInterval = setInterval(updateTimer, 1000);

    // Starta GPS
    if ("geolocation" in navigator) {
        watchId = navigator.geolocation.watchPosition(
            handlePosition,
            handleError,
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
    } else {
        alert("GPS stöds inte i denna webbläsare.");
    }

    // Begär Wake Lock
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

    // Släpp Wake Lock
    if (wakeLock !== null) {
        wakeLock.release();
        wakeLock = null;
    }

    // UI Uppdatering
    toggleBtn.textContent = 'STARTA';
    toggleBtn.classList.replace('stop', 'start');
    dimmerOverlay.classList.remove('active');
    setTimeout(() => dimmerOverlay.classList.add('hidden'), 1000);

    saveTrip();
}

function updateTimer() {
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
    const minutes = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
    const seconds = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
    timeDisplay.textContent = `${hours}:${minutes}:${seconds}`;
}

function handlePosition(position) {
    const { latitude, longitude, accuracy } = position.coords;
    console.log(`Position: ${latitude}, ${longitude} (Noggrannhet: ${accuracy}m)`);

    if (lastPosition) {
        const dist = calculateDistance(
            lastPosition.latitude, lastPosition.longitude,
            latitude, longitude
        );

        // Enkel filtrering: Ignorera hopp över 200m om noggrannheten är dålig (>30m)
        if (accuracy < 30 || dist < 0.2) {
            totalDistance += dist;
            distanceDisplay.textContent = totalDistance.toFixed(2);
        }
    }

    lastPosition = { latitude, longitude };
}

function handleError(error) {
    console.warn(`GPS Fel: ${error.message}`);
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radie i km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function saveTrip() {
    const trip = {
        date: new Date().toLocaleDateString('sv-SE'),
        time: timeDisplay.textContent,
        distance: distanceDisplay.textContent,
        timestamp: Date.now()
    };

    const trips = JSON.parse(localStorage.getItem('trips') || '[]');
    trips.unshift(trip);
    localStorage.setItem('trips', JSON.stringify(trips));

    renderTrips();
}

function renderTrips() {
    const trips = JSON.parse(localStorage.getItem('trips') || '[]');
    tripList.innerHTML = trips.map(t => `
        <li class="trip-item">
            <div class="trip-info">
                <strong>${t.date}</strong><br>
                <small>${t.time}</small>
            </div>
            <div class="trip-dist">
                ${t.distance} km
            </div>
        </li>
    `).join('');
}

// Hantera om fliken blir synlig igen (behöver återansöka Wake Lock)
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

// Initial rendering
renderTrips();
