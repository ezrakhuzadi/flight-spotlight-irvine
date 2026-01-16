/**
 * Geofences Page - 3D Geofence Visualization
 * Uses same Cesium setup as the main map page
 */

(function () {
    'use strict';

    // ========================================================================
    // Configuration
    // ========================================================================

    const CONFIG = {
        CESIUM_ION_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlNzYzZDA0ZC0xMzM2LTRiZDYtOTlmYi00YWZlYWIyMmIzZDQiLCJpZCI6Mzc5MzIwLCJpYXQiOjE3Njg1MTI0NTV9.SFfIGeLNyHKRsAD8oJdDHpNibeSoxx_ISirSN1-xKdg',
        GOOGLE_3D_TILES_ASSET_ID: 2275207,
        DEFAULT_VIEW: { lat: 33.66, lon: -117.84, height: 8000 }
    };

    // ========================================================================
    // Sample Geofences
    // ========================================================================

    const SAMPLE_GEOFENCES = [
        {
            id: 'uci-campus',
            name: 'UCI Campus Core',
            type: 'no_fly',
            owner: 'guest',
            lowerAlt: 0,
            upperAlt: 120,
            color: Cesium.Color.RED.withAlpha(0.4),
            outlineColor: Cesium.Color.RED,
            coordinates: [
                [-117.8445, 33.6405],
                [-117.8445, 33.6505],
                [-117.8345, 33.6505],
                [-117.8345, 33.6405]
            ]
        },
        {
            id: 'sna-airport',
            name: 'John Wayne Airport (SNA)',
            type: 'restricted',
            owner: 'guest',
            lowerAlt: 0,
            upperAlt: 400,
            color: Cesium.Color.YELLOW.withAlpha(0.3),
            outlineColor: Cesium.Color.YELLOW,
            coordinates: [
                [-117.8750, 33.6700],
                [-117.8750, 33.6850],
                [-117.8550, 33.6850],
                [-117.8550, 33.6700]
            ]
        },
        {
            id: 'construction-a',
            name: 'Construction Zone A',
            type: 'temporary',
            owner: 'guest',
            lowerAlt: 0,
            upperAlt: 60,
            color: Cesium.Color.CYAN.withAlpha(0.3),
            outlineColor: Cesium.Color.CYAN,
            coordinates: [
                [-117.8300, 33.6430],
                [-117.8300, 33.6460],
                [-117.8250, 33.6460],
                [-117.8250, 33.6430]
            ]
        }
    ];

    // ========================================================================
    // State
    // ========================================================================

    let viewer = null;
    const geofenceEntities = new Map();

    // ========================================================================
    // Initialization
    // ========================================================================

    async function initViewer() {
        console.log('[Geofences] Initializing Cesium viewer...');

        Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;

        viewer = new Cesium.Viewer('cesiumContainer', {
            globe: new Cesium.Globe(Cesium.Ellipsoid.WGS84),
            skyAtmosphere: new Cesium.SkyAtmosphere(),
            geocoder: false,
            homeButton: false,
            baseLayerPicker: false,
            infoBox: true,
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
            console.log('[Geofences] Google 3D Tiles loaded');
        } catch (e) {
            console.error('[Geofences] Failed to load 3D tiles:', e);
        }

        // Add geofences
        addGeofences();

        // Set initial view
        resetView();

        console.log('[Geofences] Viewer initialized');
    }

    function addGeofences() {
        SAMPLE_GEOFENCES.forEach(gf => {
            const positions = [];
            gf.coordinates.forEach(coord => {
                positions.push(coord[0], coord[1]);
            });

            const entity = viewer.entities.add({
                id: gf.id,
                name: gf.name,
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                    height: gf.lowerAlt,
                    extrudedHeight: gf.upperAlt,
                    material: gf.color,
                    outline: true,
                    outlineColor: gf.outlineColor,
                    outlineWidth: 2
                },
                description: `
                    <table class="cesium-infoBox-defaultTable">
                        <tr><td>Type:</td><td>${gf.type.replace('_', ' ').toUpperCase()}</td></tr>
                        <tr><td>Altitude:</td><td>${gf.lowerAlt}m - ${gf.upperAlt}m AGL</td></tr>
                        <tr><td>Owner:</td><td>${gf.owner}</td></tr>
                    </table>
                `
            });

            geofenceEntities.set(gf.id, { entity, data: gf });
            console.log('[Geofences] Added:', gf.name);
        });
    }

    function resetView() {
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
    }

    function focusGeofence(id) {
        const gf = geofenceEntities.get(id);
        if (gf) {
            viewer.flyTo(gf.entity, {
                offset: new Cesium.HeadingPitchRange(
                    Cesium.Math.toRadians(0),
                    Cesium.Math.toRadians(-45),
                    1500
                )
            });

            // Highlight in list
            document.querySelectorAll('.geofence-item').forEach(el => {
                el.style.background = el.dataset.id === id ? 'var(--bg-active)' : '';
            });
        }
    }

    function filterGeofences(type) {
        // Filter list
        document.querySelectorAll('.geofence-item').forEach(el => {
            el.style.display = (type === 'all' || el.dataset.type === type) ? 'flex' : 'none';
        });

        // Update buttons
        document.querySelectorAll('[data-filter]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === type);
        });

        // Update map visibility
        geofenceEntities.forEach((gf, id) => {
            gf.entity.show = (type === 'all' || gf.data.type === type);
        });
    }

    // ========================================================================
    // Global API
    // ========================================================================

    window.GeofenceControl = {
        focus: focusGeofence,
        filter: filterGeofences,
        reset: resetView
    };

    // ========================================================================
    // Bootstrap
    // ========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initViewer();
    });

})();
