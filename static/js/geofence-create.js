/**
 * Geofence Create Page
 * Lightweight Cesium draw tool to capture polygon vertices.
 */

(function () {
    'use strict';

    const CesiumConfig = window.__CESIUM_CONFIG__ || {};

    const CONFIG = {
        CESIUM_ION_TOKEN: CesiumConfig.ionToken || '',
        ION_BASE_IMAGERY_ASSET_ID: Number(CesiumConfig.ionBaseImageryAssetId) || 0,
        GOOGLE_3D_TILES_ASSET_ID: Number(CesiumConfig.google3dTilesAssetId) || 0,
        DEFAULT_VIEW: { lat: 33.66, lon: -117.84, height: 6000 }
    };

    let viewer = null;
    let drawHandler = null;
    let drawActive = false;
    const drawPoints = [];
    const drawMarkers = [];
    let drawPolygon = null;

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    async function initViewer() {
        if (CONFIG.CESIUM_ION_TOKEN) {
            Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;
        }

        const esriImagery = new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            credit: 'Esri'
        });
        esriImagery.errorEvent.addEventListener((error) => {
            console.warn('[Geofence Create] Esri imagery error:', error);
        });

        let terrainProvider = new Cesium.EllipsoidTerrainProvider();
        if (CONFIG.CESIUM_ION_TOKEN) {
            try {
                terrainProvider = await Cesium.createWorldTerrainAsync();
                console.log('[Geofence Create] Cesium World Terrain loaded');
            } catch (error) {
                console.warn('[Geofence Create] Failed to load World Terrain; using ellipsoid terrain:', error);
                terrainProvider = new Cesium.EllipsoidTerrainProvider();
            }
        }

        viewer = new Cesium.Viewer('geofenceMap', {
            imageryProvider: esriImagery,
            terrainProvider,
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

        if (CONFIG.CESIUM_ION_TOKEN && CONFIG.ION_BASE_IMAGERY_ASSET_ID) {
            try {
                const ionProvider = await Cesium.IonImageryProvider.fromAssetId(CONFIG.ION_BASE_IMAGERY_ASSET_ID);
                ionProvider.errorEvent.addEventListener((error) => {
                    console.warn('[Geofence Create] Ion imagery error:', error);
                });
                const ionLayer = viewer.imageryLayers.addImageryProvider(ionProvider);
                viewer.imageryLayers.raiseToTop(ionLayer);
                console.log(`[Geofence Create] Cesium Ion imagery loaded (asset ${CONFIG.ION_BASE_IMAGERY_ASSET_ID})`);
            } catch (error) {
                console.warn('[Geofence Create] Failed to load Ion imagery; keeping Esri imagery:', error);
            }
        }

        if (window.ATCCameraControls && typeof window.ATCCameraControls.attach === 'function') {
            window.ATCCameraControls.attach(viewer);
        }

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

        if (CONFIG.CESIUM_ION_TOKEN && CONFIG.GOOGLE_3D_TILES_ASSET_ID) {
            Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID, {
                showOutline: false,
                enableShowOutline: false
            })
                .then((tileset) => {
                    tileset.showOutline = false;
                    viewer.scene.primitives.add(tileset);
                })
                .catch((error) => console.error('[Geofence Create] Tileset load failed:', error));
        }
    }

    function setDrawMode(active) {
        drawActive = active;
        const drawButton = document.getElementById('drawOnMap');
        if (drawButton) {
            drawButton.textContent = drawActive ? 'Stop Drawing' : 'Draw on Map';
        }

        if (drawHandler) {
            drawHandler.destroy();
            drawHandler = null;
        }

        if (!drawActive) {
            return;
        }

        drawHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
        drawHandler.setInputAction((movement) => {
            const cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
            if (!cartesian) return;

            const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = clamp(Cesium.Math.toDegrees(cartographic.latitude), -90, 90);
            const lon = clamp(Cesium.Math.toDegrees(cartographic.longitude), -180, 180);
            addPoint(lat, lon);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function addPoint(lat, lon) {
        drawPoints.push({ lat, lon });
        const marker = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, 2),
            point: {
                pixelSize: 8,
                color: Cesium.Color.CYAN,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 1
            }
        });
        drawMarkers.push(marker);
        updatePolygon();
        syncPolygonTextarea();
    }

    function updatePolygon() {
        if (drawPoints.length < 3) {
            if (drawPolygon) {
                viewer.entities.remove(drawPolygon);
                drawPolygon = null;
            }
            return;
        }

        const positions = [];
        drawPoints.forEach((point) => {
            positions.push(point.lon, point.lat);
        });

        if (drawPolygon) {
            drawPolygon.polygon.hierarchy = Cesium.Cartesian3.fromDegreesArray(positions);
            return;
        }

        drawPolygon = viewer.entities.add({
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                material: Cesium.Color.CYAN.withAlpha(0.25),
                outline: true,
                outlineColor: Cesium.Color.CYAN
            }
        });
    }

    function syncPolygonTextarea() {
        const textarea = document.getElementById('polygonCoords');
        if (!textarea) return;
        textarea.value = drawPoints
            .map((point) => `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`)
            .join('\n');
    }

    function parsePolygonTextarea() {
        const textarea = document.getElementById('polygonCoords');
        if (!textarea) return [];
        return textarea.value
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const parts = line.split(/,\s*/);
                if (parts.length < 2) return null;
                const lat = Number(parts[0]);
                const lon = Number(parts[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                return [lat, lon];
            })
            .filter(Boolean);
    }

    function closePolygon(coords) {
        if (coords.length < 3) return coords;
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            coords.push([...first]);
        }
        return coords;
    }

    async function createGeofence() {
        const name = document.getElementById('geofenceName')?.value?.trim();
        const type = document.getElementById('geofenceType')?.value;
        const lowerAlt = Number(document.getElementById('lowerAlt')?.value || 0);
        const upperAlt = Number(document.getElementById('upperAlt')?.value || 0);

        let polygon = parsePolygonTextarea();
        if (!polygon.length && drawPoints.length) {
            polygon = drawPoints.map((point) => [point.lat, point.lon]);
        }

        polygon = closePolygon(polygon);

        if (!name || !type) {
            alert('Please provide a name and geofence type.');
            return;
        }
        if (!Array.isArray(polygon) || polygon.length < 4) {
            alert('Please provide at least three polygon points.');
            return;
        }

        const payload = {
            name,
            geofence_type: type,
            polygon,
            lower_altitude_m: Number.isFinite(lowerAlt) ? lowerAlt : 0,
            upper_altitude_m: Number.isFinite(upperAlt) ? upperAlt : 120
        };

        try {
            await API.createGeofence(payload);
            window.location.href = '/control/geofences';
        } catch (error) {
            console.error('[Geofence Create] Failed:', error);
            alert('Failed to create geofence. Check console for details.');
        }
    }

    function bindUI() {
        const drawButton = document.getElementById('drawOnMap');
        if (drawButton) {
            drawButton.addEventListener('click', (event) => {
                event.preventDefault();
                setDrawMode(!drawActive);
            });
        }

        const createButton = document.getElementById('createGeofence');
        if (createButton) {
            createButton.addEventListener('click', (event) => {
                event.preventDefault();
                createGeofence();
            });
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        initViewer().catch((error) => {
            console.error('[Geofence Create] Viewer init failed:', error);
        });
        bindUI();
    });
})();
