/**
 * Map Page - Full-Featured Live Tracking
 * Ported from spotlight.ejs with all 3D visualization features
 */

(function () {
    'use strict';

    // ========================================================================
    // Configuration
    // ========================================================================

    const CONFIG = {
        ATC_SERVER_URL: 'http://localhost:3000',
        CESIUM_ION_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlNzYzZDA0ZC0xMzM2LTRiZDYtOTlmYi00YWZlYWIyMmIzZDQiLCJpZCI6Mzc5MzIwLCJpYXQiOjE3Njg1MTI0NTV9.SFfIGeLNyHKRsAD8oJdDHpNibeSoxx_ISirSN1-xKdg',
        GOOGLE_3D_TILES_ASSET_ID: 2275207,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 2000 },
        MAX_TRAIL_POINTS: 60,
        HEADING_ARROW_LENGTH_M: 100,
        REFRESH_INTERVALS: {
            drones: 1000,
            conflicts: 2000,
            flightPlans: 5000,
            geofences: 10000,
            health: 5000
        }
    };

    // ========================================================================
    // State
    // ========================================================================

    let viewer = null;

    // Drone tracking
    const droneEntities = new Map();  // droneId -> Cesium.Entity
    const droneTrails = new Map();    // droneId -> [Cartesian3]
    const droneData = new Map();      // droneId -> {lat, lon, alt, speed, heading}
    const headingArrows = new Map();  // droneId -> arrow entity

    // Conflicts
    const conflictEntities = new Map();  // conflictId -> entity
    let activeConflicts = [];

    // Geofences
    const geofenceEntities = new Map();  // geofenceId -> entity

    // Flight plans
    const flightPlans = new Map();       // droneId -> plan
    let selectedRouteEntity = null;

    // Camera
    let cameraMode = 'free';  // free, orbit, cockpit
    let trackedDroneId = null;
    let selectedDroneId = null;

    // Time of day
    let currentTOD = 'realtime';

    // ========================================================================
    // Initialization
    // ========================================================================

    async function initViewer() {
        console.log('[Map] Initializing Cesium viewer...');

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

        // Enable dynamic lighting
        viewer.scene.globe.enableLighting = true;
        viewer.scene.sun.show = true;
        viewer.scene.moon.show = true;
        viewer.scene.light = new Cesium.SunLight();
        viewer.scene.globe.dynamicAtmosphereLighting = true;
        viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;

        // Set clock to real-time
        viewer.clock.currentTime = Cesium.JulianDate.now();
        viewer.clock.shouldAnimate = true;
        viewer.clock.multiplier = 1;

        // Load Google Photorealistic 3D Tiles
        try {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID);
            viewer.scene.primitives.add(tileset);
            console.log('[Map] Google Photorealistic 3D Tiles loaded');
        } catch (error) {
            console.error('[Map] Failed to load 3D Tiles:', error);
            // Fallback to ESRI imagery
            try {
                const esriImagery = new Cesium.UrlTemplateImageryProvider({
                    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                    credit: 'Esri'
                });
                viewer.imageryLayers.addImageryProvider(esriImagery);
                console.log('[Map] Fallback: Esri Imagery loaded');
            } catch (e) {
                console.error('[Map] Fallback imagery also failed', e);
            }
        }

        // Set default view to Irvine
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(CONFIG.DEFAULT_VIEW.lon, CONFIG.DEFAULT_VIEW.lat, CONFIG.DEFAULT_VIEW.height),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-45),
                roll: 0
            }
        });

        // Set up event handlers
        setupEventHandlers();

        // Start polling loops
        startPollingLoops();

        // Check for tracking param from URL
        const params = new URLSearchParams(window.location.search);
        const trackId = params.get('track');
        if (trackId) {
            trackedDroneId = trackId;
            selectedDroneId = trackId;
        }

        console.log('[Map] Viewer ready');
    }

    function setupEventHandlers() {
        // Entity selection
        viewer.selectedEntityChanged.addEventListener((entity) => {
            // Remove previous route visualization
            if (selectedRouteEntity) {
                viewer.entities.remove(selectedRouteEntity);
                selectedRouteEntity = null;
            }

            if (entity && flightPlans.has(entity.id)) {
                // Show flight plan route
                const plan = flightPlans.get(entity.id);
                const positions = plan.waypoints.map(wp =>
                    Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altitude_m)
                );

                selectedRouteEntity = viewer.entities.add({
                    polyline: {
                        positions: positions,
                        width: 2,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.fromCssColorString('#10b981'),
                            dashLength: 16.0
                        })
                    }
                });
            }

            // Update camera tracking
            if (entity && droneEntities.has(entity.id)) {
                trackedDroneId = entity.id;
                selectedDroneId = entity.id;
                updateSelectedDronePanel(droneData.get(entity.id));
                showSelectedDronePanel(true);

                if (cameraMode === 'orbit') {
                    viewer.trackedEntity = entity;
                }
            } else {
                showSelectedDronePanel(false);
                trackedDroneId = null;
                if (cameraMode === 'orbit') {
                    viewer.trackedEntity = undefined;
                }
            }
        });

        // Cockpit camera update on tick
        viewer.clock.onTick.addEventListener((clock) => {
            if (cameraMode === 'cockpit' && trackedDroneId && droneEntities.has(trackedDroneId)) {
                try {
                    const entity = droneEntities.get(trackedDroneId);
                    if (!entity || !entity.position) return;

                    const position = entity.position.getValue(clock.currentTime);
                    if (!position) return;

                    let heading = 0;
                    const data = droneData.get(trackedDroneId);
                    if (data && data.heading) {
                        heading = Cesium.Math.toRadians(data.heading);
                    }

                    const pitch = Cesium.Math.toRadians(-10);

                    viewer.camera.setView({
                        destination: position,
                        orientation: {
                            heading: heading,
                            pitch: pitch,
                            roll: 0
                        }
                    });
                } catch (e) {
                    console.warn('[Map] Cockpit camera error:', e);
                }
            }
        });
    }

    // ========================================================================
    // Polling Loops
    // ========================================================================

    function startPollingLoops() {
        // Drones
        fetchDrones();
        setInterval(fetchDrones, CONFIG.REFRESH_INTERVALS.drones);

        // Conflicts
        fetchConflicts();
        setInterval(fetchConflicts, CONFIG.REFRESH_INTERVALS.conflicts);

        // Flight plans
        fetchFlightPlans();
        setInterval(fetchFlightPlans, CONFIG.REFRESH_INTERVALS.flightPlans);

        // Geofences
        fetchGeofences();
        setInterval(fetchGeofences, CONFIG.REFRESH_INTERVALS.geofences);
    }

    // ========================================================================
    // Drone Visualization
    // ========================================================================

    async function fetchDrones() {
        try {
            console.log('[Map] Fetching drones from:', CONFIG.ATC_SERVER_URL + '/v1/drones');
            const response = await fetch(CONFIG.ATC_SERVER_URL + '/v1/drones');
            if (!response.ok) {
                console.error('[Map] Drone fetch failed:', response.status, response.statusText);
                return;
            }

            const drones = await response.json();
            console.log('[Map] Received', drones.length, 'drones:', drones.map(d => d.drone_id));

            // Update status bar
            const droneCountEl = document.getElementById('droneCountValue');
            const conflictCountEl = document.getElementById('conflictCountValue');
            if (droneCountEl) droneCountEl.textContent = drones.length;
            if (conflictCountEl) conflictCountEl.textContent = activeConflicts.length;

            // Track which drones we've seen this update
            const currentIds = new Set();

            drones.forEach(drone => {
                currentIds.add(drone.drone_id);
                updateDronePosition(
                    drone.drone_id,
                    drone.lon,
                    drone.lat,
                    drone.altitude_m,
                    drone.heading_deg,
                    drone.speed_mps
                );
            });

            // Remove stale drones
            for (const [id, entity] of droneEntities) {
                if (!currentIds.has(id)) {
                    viewer.entities.remove(entity);
                    droneEntities.delete(id);
                    droneTrails.delete(id);
                    droneData.delete(id);

                    // Remove heading arrow
                    if (headingArrows.has(id)) {
                        viewer.entities.remove(headingArrows.get(id));
                        headingArrows.delete(id);
                    }
                }
            }

            // Update sidebar list
            updateDroneList(drones);

        } catch (e) {
            console.error('[Map] Drone fetch error:', e.message);
        }
    }

    function updateDronePosition(droneId, lon, lat, altMeters, heading, speed) {
        try {
            const validLon = Number(lon) || 0;
            const validLat = Number(lat) || 0;
            const validAlt = Number(altMeters) || 0;

            if (validLon === 0 && validLat === 0) return;

            const position = Cesium.Cartesian3.fromDegrees(validLon, validLat, validAlt);

            // Update trail history
            if (!droneTrails.has(droneId)) {
                droneTrails.set(droneId, []);
            }
            const trail = droneTrails.get(droneId);
            trail.push(position);
            if (trail.length > CONFIG.MAX_TRAIL_POINTS) {
                trail.shift();
            }

            // Description HTML
            const description = `
                <table style="font-size: 12px;">
                    <tr><td>ID:</td><td><strong>${droneId}</strong></td></tr>
                    <tr><td>Speed:</td><td>${(speed || 0).toFixed(1)} m/s</td></tr>
                    <tr><td>Heading:</td><td>${(heading || 0).toFixed(0)}°</td></tr>
                    <tr><td>Altitude:</td><td>${altMeters.toFixed(0)} m</td></tr>
                    <tr><td>Position:</td><td>${lat.toFixed(5)}, ${lon.toFixed(5)}</td></tr>
                </table>
            `;

            if (!droneEntities.has(droneId)) {
                // Create new drone entity with 3D model
                const headingRad = Cesium.Math.toRadians(heading || 0);
                const hpr = new Cesium.HeadingPitchRoll(headingRad, 0, 0);
                const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

                const entity = viewer.entities.add({
                    id: droneId,
                    name: `Drone ${droneId}`,
                    position: position,
                    orientation: orientation,
                    // 3D Drone Model
                    model: {
                        uri: '/assets/models/drone.glb',
                        minimumPixelSize: 32,
                        maximumScale: 200,
                        scale: 0.5,
                        silhouetteColor: Cesium.Color.CYAN,
                        silhouetteSize: 1.5,
                        colorBlendMode: Cesium.ColorBlendMode.HIGHLIGHT,
                        colorBlendAmount: 0.0
                    },
                    label: {
                        text: `${droneId}\n${(speed || 0).toFixed(1)} m/s`,
                        font: '12px Inter, sans-serif',
                        fillColor: Cesium.Color.WHITE,
                        showBackground: true,
                        backgroundColor: Cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7),
                        backgroundPadding: new Cesium.Cartesian2(4, 4),
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -40),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000)
                    },
                    description: description,
                    // Trail polyline
                    polyline: {
                        positions: new Cesium.CallbackProperty(() => droneTrails.get(droneId), false),
                        width: 3,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.2,
                            color: Cesium.Color.YELLOW
                        })
                    }
                });

                droneEntities.set(droneId, entity);
                console.log(`[Map] Created drone: ${droneId}`);

            } else {
                // Update existing drone
                const entity = droneEntities.get(droneId);
                entity.position = position;

                const headingRad = Cesium.Math.toRadians(heading || 0);
                const hpr = new Cesium.HeadingPitchRoll(headingRad, 0, 0);
                entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

                entity.description = description;
                entity.label.text = `${droneId}\n${(speed || 0).toFixed(1)} m/s`;
            }

            // Store data
            droneData.set(droneId, { lat: validLat, lon: validLon, alt: validAlt, speed, heading });

            // Update heading arrow
            const headingRad = Cesium.Math.toRadians(heading || 0);
            const arrowEndLat = validLat + (CONFIG.HEADING_ARROW_LENGTH_M / 111320) * Math.cos(headingRad);
            const arrowEndLon = validLon + (CONFIG.HEADING_ARROW_LENGTH_M / (111320 * Math.cos(validLat * Math.PI / 180))) * Math.sin(headingRad);
            const arrowEnd = Cesium.Cartesian3.fromDegrees(arrowEndLon, arrowEndLat, validAlt);

            if (!headingArrows.has(droneId)) {
                const arrow = viewer.entities.add({
                    id: `arrow-${droneId}`,
                    polyline: {
                        positions: [position, arrowEnd],
                        width: 6,
                        material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.CYAN)
                    }
                });
                headingArrows.set(droneId, arrow);
            } else {
                const arrow = headingArrows.get(droneId);
                arrow.polyline.positions = [position, arrowEnd];
            }

            // Update selected drone panel if this is the selected drone
            if (selectedDroneId === droneId) {
                updateSelectedDronePanel({ lat: validLat, lon: validLon, alt: validAlt, speed, heading });
            }

        } catch (error) {
            console.error('[Map] Error updating drone position:', error);
        }
    }

    // ========================================================================
    // Conflict Visualization
    // ========================================================================

    async function fetchConflicts() {
        try {
            const response = await fetch(CONFIG.ATC_SERVER_URL + '/v1/conflicts');
            if (!response.ok) return;

            const conflicts = await response.json();
            activeConflicts = conflicts;
            renderConflicts(conflicts);
            updateConflictsList(conflicts);

        } catch (e) {
            // Server might not be running
        }
    }

    function renderConflicts(conflicts) {
        // Remove old conflict entities
        const currentConflictIds = new Set(conflicts.map(c => `${c.drone1_id}-${c.drone2_id}`));
        for (const [id, entity] of conflictEntities) {
            if (!currentConflictIds.has(id)) {
                viewer.entities.remove(entity);
                conflictEntities.delete(id);
            }
        }

        // Add/update conflict lines
        for (const conflict of conflicts) {
            const conflictId = `${conflict.drone1_id}-${conflict.drone2_id}`;

            const drone1 = droneEntities.get(conflict.drone1_id);
            const drone2 = droneEntities.get(conflict.drone2_id);
            if (!drone1 || !drone2) continue;

            const pos1 = drone1.position?.getValue(viewer.clock.currentTime);
            const pos2 = drone2.position?.getValue(viewer.clock.currentTime);
            if (!pos1 || !pos2) continue;

            // Color based on severity
            let lineColor, lineWidth;
            if (conflict.severity === 'critical') {
                lineColor = Cesium.Color.RED;
                lineWidth = 4;
            } else if (conflict.severity === 'warning') {
                lineColor = Cesium.Color.ORANGE;
                lineWidth = 3;
            } else {
                lineColor = Cesium.Color.YELLOW;
                lineWidth = 2;
            }

            if (conflictEntities.has(conflictId)) {
                const entity = conflictEntities.get(conflictId);
                entity.polyline.positions = [pos1, pos2];
            } else {
                const entity = viewer.entities.add({
                    id: `conflict-${conflictId}`,
                    polyline: {
                        positions: [pos1, pos2],
                        width: lineWidth,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.3,
                            color: lineColor
                        })
                    }
                });
                conflictEntities.set(conflictId, entity);
                console.log(`[Map] Conflict: ${conflict.severity.toUpperCase()} ${conflict.drone1_id} <-> ${conflict.drone2_id}`);
            }

            // Color drone models based on conflict
            if (conflict.severity === 'critical') {
                if (drone1.model) drone1.model.silhouetteColor = Cesium.Color.RED;
                if (drone2.model) drone2.model.silhouetteColor = Cesium.Color.RED;
            } else if (conflict.severity === 'warning') {
                if (drone1.model) drone1.model.silhouetteColor = Cesium.Color.ORANGE;
                if (drone2.model) drone2.model.silhouetteColor = Cesium.Color.ORANGE;
            }
        }

        // Reset non-conflicting drones
        const conflictingDrones = new Set();
        conflicts.forEach(c => {
            conflictingDrones.add(c.drone1_id);
            conflictingDrones.add(c.drone2_id);
        });
        for (const [id, entity] of droneEntities) {
            if (!conflictingDrones.has(id) && entity.model) {
                entity.model.silhouetteColor = Cesium.Color.CYAN;
            }
        }
    }

    // ========================================================================
    // Geofence Visualization
    // ========================================================================

    async function fetchGeofences() {
        try {
            const response = await fetch(CONFIG.ATC_SERVER_URL + '/v1/geofences');
            if (!response.ok) return;

            const geofences = await response.json();
            renderGeofences(geofences);

        } catch (e) {
            // Server might not be running
        }
    }

    function renderGeofences(geofences) {
        // Remove old geofences
        const currentIds = new Set(geofences.map(g => g.id));
        for (const [id, entity] of geofenceEntities) {
            if (!currentIds.has(id)) {
                viewer.entities.remove(entity);
                geofenceEntities.delete(id);
            }
        }

        for (const geofence of geofences) {
            if (geofenceEntities.has(geofence.id)) continue;

            // Convert polygon to Cesium positions
            const positions = geofence.polygon.map(([lat, lon]) =>
                Cesium.Cartesian3.fromDegrees(lon, lat, geofence.upper_altitude_m)
            );

            // Color based on type
            let fillColor, outlineColor;
            switch (geofence.geofence_type) {
                case 'no_fly_zone':
                    fillColor = Cesium.Color.RED.withAlpha(0.3);
                    outlineColor = Cesium.Color.RED;
                    break;
                case 'restricted_area':
                    fillColor = Cesium.Color.ORANGE.withAlpha(0.25);
                    outlineColor = Cesium.Color.ORANGE;
                    break;
                case 'temporary_restriction':
                    fillColor = Cesium.Color.YELLOW.withAlpha(0.2);
                    outlineColor = Cesium.Color.YELLOW;
                    break;
                default:
                    fillColor = Cesium.Color.BLUE.withAlpha(0.15);
                    outlineColor = Cesium.Color.BLUE;
            }

            const entity = viewer.entities.add({
                id: `geofence-${geofence.id}`,
                name: geofence.name,
                polygon: {
                    hierarchy: positions,
                    height: geofence.lower_altitude_m,
                    extrudedHeight: geofence.upper_altitude_m,
                    material: fillColor,
                    outline: true,
                    outlineColor: outlineColor,
                    outlineWidth: 2
                }
            });

            geofenceEntities.set(geofence.id, entity);
            console.log(`[Map] Geofence: ${geofence.name} (${geofence.geofence_type})`);
        }
    }

    // ========================================================================
    // Flight Plans
    // ========================================================================

    async function fetchFlightPlans() {
        try {
            const response = await fetch(CONFIG.ATC_SERVER_URL + '/v1/flights');
            if (!response.ok) return;

            const plans = await response.json();
            plans.forEach(plan => {
                flightPlans.set(plan.drone_id, plan);
            });

        } catch (e) {
            // Server might not be running
        }
    }

    // ========================================================================
    // UI Updates
    // ========================================================================

    function updateDroneList(drones) {
        const container = document.getElementById('activeDronesList');
        if (!container) return;

        if (!drones || drones.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 16px;">
                    <div class="empty-state-text text-muted">No active drones</div>
                </div>
            `;
            return;
        }

        container.innerHTML = drones.map(drone => `
            <div class="drone-track-item ${selectedDroneId === drone.drone_id ? 'selected' : ''}" 
                 onclick="MapControl.selectDrone('${drone.drone_id}')">
                <span class="status-dot ${getStatusClass(drone.status)}"></span>
                <div class="list-item-content">
                    <div class="list-item-title" style="font-size: 13px;">${drone.drone_id}</div>
                    <div class="list-item-subtitle" style="font-size: 11px;">${drone.altitude_m.toFixed(0)}m | ${drone.speed_mps.toFixed(1)} m/s</div>
                </div>
            </div>
        `).join('');
    }

    function updateConflictsList(conflicts) {
        const container = document.getElementById('conflictsList');
        if (!container) return;

        if (!conflicts || conflicts.length === 0) {
            container.innerHTML = `
                <div class="status-badge online" style="margin: 8px 0;">
                    <span class="status-dot online"></span>
                    <span>All Clear</span>
                </div>
            `;
            return;
        }

        container.innerHTML = conflicts.map(c => `
            <div class="list-item" style="padding: 8px; background: rgba(239,68,68,0.1); border-color: var(--accent-red); margin-bottom: 4px;">
                <div class="list-item-content">
                    <div class="list-item-title text-danger" style="font-size: 12px;">
                        ${c.drone1_id} - ${c.drone2_id}
                    </div>
                    <div class="list-item-subtitle">${c.distance_m.toFixed(0)}m apart</div>
                </div>
            </div>
        `).join('');
    }

    function showSelectedDronePanel(show) {
        const panel = document.getElementById('selectedDronePanel');
        if (panel) panel.style.display = show ? 'block' : 'none';
    }

    function updateSelectedDronePanel(data) {
        if (!data) return;

        const nameEl = document.getElementById('selectedDroneName');
        const latEl = document.getElementById('selectedDroneLat');
        const lonEl = document.getElementById('selectedDroneLon');
        const altEl = document.getElementById('selectedDroneAlt');
        const speedEl = document.getElementById('selectedDroneSpeed');
        const statusEl = document.getElementById('selectedDroneStatus');

        if (nameEl) nameEl.textContent = selectedDroneId || '--';
        if (latEl) latEl.textContent = data.lat?.toFixed(6) || '--';
        if (lonEl) lonEl.textContent = data.lon?.toFixed(6) || '--';
        if (altEl) altEl.textContent = data.alt?.toFixed(1) || '--';
        if (speedEl) speedEl.textContent = data.speed?.toFixed(1) || '--';
        if (statusEl) statusEl.className = 'status-dot flying';
    }

    function getStatusClass(status) {
        switch (status) {
            case 'InFlight':
            case 'Rerouting':
                return 'flying';
            case 'Ready':
            case 'Registered':
                return 'online';
            case 'Lost':
                return 'offline';
            default:
                return 'online';
        }
    }

    // ========================================================================
    // Camera Controls
    // ========================================================================

    function setCameraMode(mode) {
        cameraMode = mode;
        console.log('[Map] Camera mode:', mode);

        if (mode === 'free') {
            viewer.trackedEntity = undefined;
        } else if (mode === 'orbit') {
            if (trackedDroneId && droneEntities.has(trackedDroneId)) {
                viewer.trackedEntity = droneEntities.get(trackedDroneId);
            }
        } else if (mode === 'cockpit') {
            viewer.trackedEntity = undefined;
        }

        // Update button styles
        ['free', 'orbit', 'cockpit'].forEach(m => {
            const btn = document.getElementById(`cam-${m}-btn`);
            if (btn) {
                if (m === mode) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        });
    }

    function setTimeOfDay(mode) {
        currentTOD = mode;
        console.log('[Map] Time of day:', mode);

        if (mode === 'realtime') {
            viewer.clock.currentTime = Cesium.JulianDate.now();
            viewer.clock.shouldAnimate = true;
            viewer.clock.multiplier = 1;
        } else if (mode === 'day') {
            const noon = new Date();
            noon.setUTCHours(12, 0, 0, 0);
            viewer.clock.currentTime = Cesium.JulianDate.fromDate(noon);
            viewer.clock.shouldAnimate = false;
        } else if (mode === 'night') {
            const midnight = new Date();
            midnight.setUTCHours(0, 0, 0, 0);
            viewer.clock.currentTime = Cesium.JulianDate.fromDate(midnight);
            viewer.clock.shouldAnimate = false;
        }
    }

    // ========================================================================
    // Drone Selection & Commands
    // ========================================================================

    function selectDrone(droneId) {
        selectedDroneId = droneId;
        trackedDroneId = droneId;

        const entity = droneEntities.get(droneId);
        if (entity) {
            viewer.selectedEntity = entity;

            if (cameraMode !== 'cockpit') {
                viewer.flyTo(entity, {
                    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 500)
                });
            }
        }

        showSelectedDronePanel(true);
        const data = droneData.get(droneId);
        if (data) updateSelectedDronePanel(data);
    }

    async function holdDrone() {
        if (!selectedDroneId) return;

        try {
            await fetch(CONFIG.ATC_SERVER_URL + '/v1/commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drone_id: selectedDroneId,
                    type: 'HOLD',
                    duration_secs: 30
                })
            });
            console.log(`[Map] HOLD sent to ${selectedDroneId}`);
        } catch (e) {
            console.error('[Map] Hold command failed:', e);
        }
    }

    async function resumeDrone() {
        if (!selectedDroneId) return;

        try {
            await fetch(CONFIG.ATC_SERVER_URL + '/v1/commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drone_id: selectedDroneId,
                    type: 'RESUME'
                })
            });
            console.log(`[Map] RESUME sent to ${selectedDroneId}`);
        } catch (e) {
            console.error('[Map] Resume command failed:', e);
        }
    }

    // ========================================================================
    // Initialize on DOM Ready
    // ========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initViewer();

        // Command buttons
        const holdBtn = document.getElementById('btnHoldDrone');
        const resumeBtn = document.getElementById('btnResumeDrone');

        if (holdBtn) holdBtn.addEventListener('click', holdDrone);
        if (resumeBtn) resumeBtn.addEventListener('click', resumeDrone);
    });

    // ========================================================================
    // Public API
    // ========================================================================

    window.MapControl = {
        selectDrone,
        holdDrone,
        resumeDrone,
        setCameraMode,
        setTimeOfDay,
        getViewer: () => viewer
    };

})();
