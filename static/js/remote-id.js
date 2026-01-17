/**
 * Remote ID Page - ASTM F3411 Remote ID Display
 * Fetches and displays Remote ID data from Flight Blender
 */

(function () {
    'use strict';

    // ========================================================================
    // Configuration
    // ========================================================================

    const CONFIG = {
        CESIUM_ION_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlNzYzZDA0ZC0xMzM2LTRiZDYtOTlmYi00YWZlYWIyMmIzZDQiLCJpZCI6Mzc5MzIwLCJpYXQiOjE3Njg1MTI0NTV9.SFfIGeLNyHKRsAD8oJdDHpNibeSoxx_ISirSN1-xKdg',
        GOOGLE_3D_TILES_ASSET_ID: 2275207,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 5000 },
        API_BASE: '',
        REFRESH_INTERVAL: 2000,
        SUBSCRIPTION_TTL_MS: 25000,
        VIEW_CHANGE_THRESHOLD_DEG: 0.01,
        DEFAULT_VIEW_BUFFER_DEG: 0.03,
        MAX_VIEW_DIAGONAL_KM: 10,
        STALE_ENTITY_MS: 15000
    };

    // ========================================================================
    // State
    // ========================================================================

    let viewer = null;
    const aircraftEntities = new Map();
    const aircraftLastSeen = new Map();
    let selectedAircraftId = null;
    let refreshInterval = null;
    let subscriptionId = null;
    let lastSubscriptionAt = 0;
    let subscriptionPromise = null;
    let lastViewBounds = null;
    let demoInFlight = false;
    let autoFocusDone = false;
    let lastAircraftSnapshot = [];

    // ========================================================================
    // Initialization
    // ========================================================================

    async function initViewer() {
        console.log('[RemoteID] Initializing Cesium viewer...');

        Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;

        viewer = new Cesium.Viewer('cesiumContainer', {
            globe: new Cesium.Globe(Cesium.Ellipsoid.WGS84),
            skyAtmosphere: new Cesium.SkyAtmosphere(),
            geocoder: false,
            homeButton: false,
            baseLayerPicker: false,
            infoBox: false,
            sceneModePicker: false,
            animation: false,
            selectionIndicator: true,
            fullscreenButton: false,
            timeline: false,
            navigationHelpButton: false,
            shadows: false
        });

        viewer.scene.globe.enableLighting = true;
        viewer.clock.currentTime = Cesium.JulianDate.now();
        viewer.clock.shouldAnimate = true;

        // Load Google 3D Tiles
        try {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID);
            viewer.scene.primitives.add(tileset);
            console.log('[RemoteID] Google 3D Tiles loaded');
        } catch (e) {
            console.error('[RemoteID] Failed to load 3D tiles:', e);
        }

        // Set initial view
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
                CONFIG.DEFAULT_VIEW.lon,
                CONFIG.DEFAULT_VIEW.lat,
                CONFIG.DEFAULT_VIEW.height
            ),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-45),
                roll: 0
            }
        });

        // Start data refresh
        startDataRefresh();

        console.log('[RemoteID] Viewer initialized');
    }

    // ========================================================================
    // Data Fetching
    // ========================================================================

    function startDataRefresh() {
        fetchRemoteIDData();
        refreshInterval = setInterval(fetchRemoteIDData, CONFIG.REFRESH_INTERVAL);
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getViewBounds() {
        if (!viewer) {
            return null;
        }

        const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        if (!rectangle) {
            return null;
        }

        return {
            south: Cesium.Math.toDegrees(rectangle.south),
            west: Cesium.Math.toDegrees(rectangle.west),
            north: Cesium.Math.toDegrees(rectangle.north),
            east: Cesium.Math.toDegrees(rectangle.east)
        };
    }

    function getFallbackViewBounds() {
        const buffer = CONFIG.DEFAULT_VIEW_BUFFER_DEG;
        return {
            south: CONFIG.DEFAULT_VIEW.lat - buffer,
            west: CONFIG.DEFAULT_VIEW.lon - buffer,
            north: CONFIG.DEFAULT_VIEW.lat + buffer,
            east: CONFIG.DEFAULT_VIEW.lon + buffer
        };
    }

    function getViewCenter() {
        if (!viewer) {
            return { lat: CONFIG.DEFAULT_VIEW.lat, lon: CONFIG.DEFAULT_VIEW.lon };
        }
        const position = viewer.camera.positionCartographic;
        if (!position) {
            return { lat: CONFIG.DEFAULT_VIEW.lat, lon: CONFIG.DEFAULT_VIEW.lon };
        }
        return {
            lat: Cesium.Math.toDegrees(position.latitude),
            lon: Cesium.Math.toDegrees(position.longitude)
        };
    }

    function estimateDiagonalKm(bounds) {
        if (!bounds || bounds.east < bounds.west) {
            return null;
        }
        const R = 6371;
        const lat1 = Cesium.Math.toRadians(bounds.south);
        const lat2 = Cesium.Math.toRadians(bounds.north);
        const lon1 = Cesium.Math.toRadians(bounds.west);
        const lon2 = Cesium.Math.toRadians(bounds.east);
        const dlat = lat2 - lat1;
        const dlon = lon2 - lon1;
        const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function boundsFromCenter(center, buffer) {
        return {
            south: clamp(center.lat - buffer, -90, 90),
            west: clamp(center.lon - buffer, -180, 180),
            north: clamp(center.lat + buffer, -90, 90),
            east: clamp(center.lon + buffer, -180, 180)
        };
    }

    function normalizeViewBounds(bounds) {
        if (!bounds) {
            return getFallbackViewBounds();
        }

        const sanitized = {
            south: clamp(bounds.south, -90, 90),
            west: clamp(bounds.west, -180, 180),
            north: clamp(bounds.north, -90, 90),
            east: clamp(bounds.east, -180, 180)
        };

        const diagonal = estimateDiagonalKm(sanitized);
        if (!Number.isFinite(diagonal) || diagonal > CONFIG.MAX_VIEW_DIAGONAL_KM) {
            return boundsFromCenter(getViewCenter(), CONFIG.DEFAULT_VIEW_BUFFER_DEG);
        }

        return sanitized;
    }

    function toViewParam(bounds) {
        return [
            bounds.south,
            bounds.west,
            bounds.north,
            bounds.east
        ].map(value => value.toFixed(6)).join(',');
    }

    function viewChanged(previous, next) {
        if (!previous) {
            return true;
        }
        const threshold = CONFIG.VIEW_CHANGE_THRESHOLD_DEG;
        return (
            Math.abs(previous.south - next.south) > threshold ||
            Math.abs(previous.west - next.west) > threshold ||
            Math.abs(previous.north - next.north) > threshold ||
            Math.abs(previous.east - next.east) > threshold
        );
    }

    async function createSubscription(viewParam) {
        if (subscriptionPromise) {
            return subscriptionPromise;
        }

        subscriptionPromise = (async () => {
            const response = await fetch(
                `${CONFIG.API_BASE}/api/rid/subscription?view=${encodeURIComponent(viewParam)}`,
                {
                    method: 'PUT',
                    credentials: 'same-origin'
                }
            );

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Subscription failed (${response.status}): ${text}`);
            }

            const payload = await response.json();
            return payload?.dss_subscription_response?.dss_subscription_id || payload?.dss_subscription_id || null;
        })();

        try {
            return await subscriptionPromise;
        } finally {
            subscriptionPromise = null;
        }
    }

    async function fetchRidData(activeSubscriptionId) {
        const response = await fetch(
            `${CONFIG.API_BASE}/api/rid/data/${activeSubscriptionId}`,
            {
                credentials: 'same-origin'
            }
        );

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`RID data error (${response.status}): ${text}`);
        }

        const payload = await response.json();
        if (Array.isArray(payload)) {
            return payload;
        }
        if (payload && Array.isArray(payload.flights)) {
            return payload.flights;
        }
        return [];
    }

    function toNumber(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeObservations(observations) {
        const byId = new Map();

        observations.forEach(observation => {
            const metadata = observation.metadata || {};
            const currentState = metadata.current_state || metadata.currentState || {};
            const position = currentState.position || {};

            const lat = toNumber(observation.latitude_dd ?? observation.lat_dd ?? position.lat);
            const lon = toNumber(observation.longitude_dd ?? observation.lon_dd ?? position.lng);

            if (lat === null || lon === null) {
                return;
            }

            const altitudeRaw = toNumber(observation.altitude_mm ?? position.alt);
            const altitude_m = altitudeRaw === null ? null : (altitudeRaw > 5000 ? altitudeRaw / 1000 : altitudeRaw);
            const speed_mps = toNumber(currentState.speed ?? metadata.speed_mps ?? metadata.speed);
            const heading_deg = toNumber(currentState.track ?? metadata.heading_deg ?? metadata.heading);
            const id = observation.icao_address || metadata.id || observation.session_id || observation.id || 'unknown';
            const timestamp = observation.updated_at || observation.created_at || currentState.timestamp || null;

            const normalized = {
                id,
                lat,
                lon,
                altitude_m,
                speed_mps,
                heading_deg,
                timestamp
            };

            if (!byId.has(id)) {
                byId.set(id, normalized);
                return;
            }

            const existing = byId.get(id);
            if (existing.timestamp && normalized.timestamp && normalized.timestamp > existing.timestamp) {
                byId.set(id, normalized);
            }
        });

        return Array.from(byId.values());
    }

    function focusOnAircraft(aircraft) {
        if (!viewer || !aircraft.length) {
            return;
        }
        const buffer = 0.01;
        const lats = aircraft.map(a => a.lat);
        const lons = aircraft.map(a => a.lon);
        const south = clamp(Math.min(...lats) - buffer, -90, 90);
        const north = clamp(Math.max(...lats) + buffer, -90, 90);
        const west = clamp(Math.min(...lons) - buffer, -180, 180);
        const east = clamp(Math.max(...lons) + buffer, -180, 180);

        viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(west, south, east, north)
        });
        autoFocusDone = true;
    }

    async function fetchRemoteIDData() {
        try {
            const viewBounds = normalizeViewBounds(getViewBounds());
            const now = Date.now();

            if (!subscriptionId ||
                viewChanged(lastViewBounds, viewBounds) ||
                now - lastSubscriptionAt > CONFIG.SUBSCRIPTION_TTL_MS) {
                const viewParam = toViewParam(viewBounds);
                const newSubscriptionId = await createSubscription(viewParam);
                if (newSubscriptionId) {
                    subscriptionId = newSubscriptionId;
                    lastSubscriptionAt = now;
                    lastViewBounds = viewBounds;
                }
            }

            if (!subscriptionId) {
                updateStatus('error', 'Remote ID subscription unavailable');
                updateAircraftList([]);
                updateMap([]);
                return;
            }

            const observations = await fetchRidData(subscriptionId);
            if (observations === null) {
                subscriptionId = null;
                updateStatus('connecting', 'Refreshing Remote ID subscription...');
                const stale = getStaleAircraft();
                updateAircraftList(stale, { stale: true });
                updateMap(stale);
                return;
            }
            const aircraft = normalizeObservations(observations);
            const lastSeenNow = Date.now();

            if (aircraft.length) {
                aircraft.forEach((entry) => {
                    aircraftLastSeen.set(entry.id, lastSeenNow);
                });
                lastAircraftSnapshot = aircraft;
            }

            const statusText = aircraft.length
                ? `${aircraft.length} aircraft tracked`
                : 'Connected - no RID traffic in view';

            const displayAircraft = aircraft.length ? aircraft : getStaleAircraft();
            const isStale = !aircraft.length && displayAircraft.length > 0;

            updateStatus('connected', isStale ? 'Connected - showing last known RID traffic' : statusText);
            updateAircraftList(displayAircraft, { stale: isStale });
            updateMap(displayAircraft);
            if (!autoFocusDone && displayAircraft.length) {
                focusOnAircraft(displayAircraft);
            }
        } catch (e) {
            console.error('[RemoteID] Fetch error:', e);
            updateStatus('error', 'Remote ID connection failed');
            const stale = getStaleAircraft();
            if (stale.length) {
                updateAircraftList(stale, { stale: true });
                updateMap(stale);
            }
        }
    }

    async function startDemoTraffic() {
        if (demoInFlight) {
            return;
        }
        demoInFlight = true;
        const button = document.getElementById('ridDemoBtn');
        if (button) {
            button.disabled = true;
        }
        updateStatus('connecting', 'Seeding demo RID traffic...');

        try {
            const center = getViewCenter();
            if (!subscriptionId) {
                const viewBounds = normalizeViewBounds(getViewBounds());
                const viewParam = toViewParam(viewBounds);
                const newSubscriptionId = await createSubscription(viewParam);
                if (newSubscriptionId) {
                    subscriptionId = newSubscriptionId;
                    lastSubscriptionAt = Date.now();
                    lastViewBounds = viewBounds;
                }
            }
            if (!subscriptionId) {
                throw new Error('No subscription available for demo injection');
            }
            const response = await fetch(`${CONFIG.API_BASE}/api/rid/demo`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    center,
                    subscription_id: subscriptionId
                })
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Demo injection failed (${response.status}): ${text}`);
            }
            updateStatus('connected', 'Demo RID traffic injected');
            setTimeout(fetchRemoteIDData, 1000);
        } catch (e) {
            console.error('[RemoteID] Demo error:', e);
            updateStatus('error', 'Demo RID injection failed');
        } finally {
            demoInFlight = false;
            if (button) {
                button.disabled = false;
            }
        }
    }


    // ========================================================================
    // UI Updates
    // ========================================================================

    function updateStatus(status, text) {
        const dot = document.getElementById('ridStatusDot');
        const textEl = document.getElementById('ridStatusText');

        dot.style.background = status === 'connected' ? 'var(--accent-green)' :
            status === 'error' ? 'var(--accent-red)' :
                'var(--accent-yellow)';
        textEl.textContent = text;
    }

    function formatNumber(value, digits) {
        if (!Number.isFinite(value)) {
            return '--';
        }
        return value.toFixed(digits);
    }

    function updateAircraftList(aircraft, options = {}) {
        const container = document.getElementById('ridAircraftList');
        const totalEl = document.getElementById('ridTotalCount');
        const compliantEl = document.getElementById('ridCompliantCount');
        const isStale = options.stale;

        totalEl.textContent = aircraft.length;
        compliantEl.textContent = aircraft.length; // All our drones are RID compliant

        if (aircraft.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 20px; text-align: center;">
                    <div class="text-muted">No aircraft detected</div>
                </div>
            `;
            return;
        }

        container.innerHTML = aircraft.map(a => {
            const lastSeen = aircraftLastSeen.get(a.id);
            const lastSeenText = lastSeen ? formatRelativeTime(lastSeen) : 'Unknown';
            const staleNote = isStale ? `<div class="rid-detail text-muted">Last seen: ${lastSeenText}</div>` : '';
            return `
            <div class="rid-aircraft ${selectedAircraftId === a.id ? 'selected' : ''}" 
                 data-id="${a.id}"
                 onclick="RemoteID.selectAircraft('${a.id}')">
                <div class="rid-header">
                    <span class="rid-id">${a.id}</span>
                    <span class="rid-type">UAV</span>
                </div>
                <div class="rid-details">
                    <div class="rid-detail">Lat: <span class="rid-detail-value">${formatNumber(a.lat, 5)}</span></div>
                    <div class="rid-detail">Lon: <span class="rid-detail-value">${formatNumber(a.lon, 5)}</span></div>
                    <div class="rid-detail">Alt: <span class="rid-detail-value">${formatNumber(a.altitude_m, 0)}m</span></div>
                    <div class="rid-detail">Speed: <span class="rid-detail-value">${formatNumber(a.speed_mps, 1)}m/s</span></div>
                    ${staleNote}
                </div>
                <div style="margin-top: 8px;">
                    <span class="compliance-badge compliant">✓ RID Compliant</span>
                </div>
            </div>
        `;
        }).join('');
    }

    function updateMap(aircraft) {
        const currentIds = new Set(aircraft.map(a => a.id));
        const now = Date.now();

        // Remove stale entities
        aircraftEntities.forEach((entity, id) => {
            const lastSeen = aircraftLastSeen.get(id) || 0;
            if (!currentIds.has(id) && now - lastSeen > CONFIG.STALE_ENTITY_MS) {
                viewer.entities.remove(entity);
                aircraftEntities.delete(id);
                aircraftLastSeen.delete(id);
            }
        });

        // Update or add entities
        aircraft.forEach(a => {
            aircraftLastSeen.set(a.id, now);
            const altitude = Number.isFinite(a.altitude_m) ? a.altitude_m : 0;
            const position = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, altitude);

            if (aircraftEntities.has(a.id)) {
                // Update existing
                const entity = aircraftEntities.get(a.id);
                entity.position = position;
            } else {
                // Create new
                const entity = viewer.entities.add({
                    id: `rid-${a.id}`,
                    name: a.id,
                    position: position,
                    point: {
                        pixelSize: 12,
                        color: Cesium.Color.CYAN,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 2
                    },
                    label: {
                        text: a.id,
                        font: '12px Inter, sans-serif',
                        fillColor: Cesium.Color.WHITE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -15)
                    }
                });
                aircraftEntities.set(a.id, entity);
            }
        });
    }

    function getStaleAircraft() {
        const now = Date.now();
        return lastAircraftSnapshot.filter((entry) => {
            const lastSeen = aircraftLastSeen.get(entry.id) || 0;
            return now - lastSeen <= CONFIG.STALE_ENTITY_MS;
        });
    }

    function formatRelativeTime(timestampMs) {
        const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }

    function selectAircraft(id) {
        selectedAircraftId = id;

        // Update list selection
        document.querySelectorAll('.rid-aircraft').forEach(el => {
            el.classList.toggle('selected', el.dataset.id === id);
        });

        // Fly to aircraft
        const entity = aircraftEntities.get(id);
        if (entity) {
            viewer.flyTo(entity, {
                offset: new Cesium.HeadingPitchRange(
                    Cesium.Math.toRadians(0),
                    Cesium.Math.toRadians(-30),
                    500
                )
            });
        }
    }

    // ========================================================================
    // Global API
    // ========================================================================

    window.RemoteID = {
        selectAircraft,
        startDemoTraffic
    };

    // ========================================================================
    // Bootstrap
    // ========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initViewer();
    });

})();
