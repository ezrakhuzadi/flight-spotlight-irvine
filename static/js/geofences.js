/**
 * Geofences Page - 3D Geofence Visualization
 * Uses same Cesium setup as the main map page
 */

(function () {
    'use strict';

    // ========================================================================
    // Configuration
    // ========================================================================

    const CesiumConfig = window.__CESIUM_CONFIG__ || {};

    const CONFIG = {
        CESIUM_ION_TOKEN: CesiumConfig.ionToken || '',
        ION_BASE_IMAGERY_ASSET_ID: Number(CesiumConfig.ionBaseImageryAssetId) || 0,
        GOOGLE_3D_TILES_ASSET_ID: Number(CesiumConfig.google3dTilesAssetId) || 0,
        DEFAULT_VIEW: { lat: 33.66, lon: -117.84, height: 8000 }
    };
    const escapeHtml = window.escapeHtml || ((value) => String(value ?? ''));

    // ========================================================================
    // State
    // ========================================================================

    let viewer = null;
    let geofences = [];
    let activeFilter = 'all';
    const geofenceEntities = new Map();
    const canManage = window.APP_USER && (window.APP_USER.role === 'authority' || window.APP_USER.role === 'admin');
    let lastLoadError = null;

    // ========================================================================
    // Initialization
    // ========================================================================

    async function initViewer() {
        console.log('[Geofences] Initializing Cesium viewer...');

        if (CONFIG.CESIUM_ION_TOKEN) {
            Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;
        }

        const esriImagery = new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            credit: 'Esri'
        });
        esriImagery.errorEvent.addEventListener((error) => {
            console.warn('[Geofences] Esri imagery error:', error);
        });

        viewer = new Cesium.Viewer('cesiumContainer', {
            imageryProvider: esriImagery,
            terrainProvider: new Cesium.EllipsoidTerrainProvider(),
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

        if (CONFIG.CESIUM_ION_TOKEN) {
            if (CONFIG.ION_BASE_IMAGERY_ASSET_ID) {
                try {
                    const ionProvider = await Cesium.IonImageryProvider.fromAssetId(CONFIG.ION_BASE_IMAGERY_ASSET_ID);
                    ionProvider.errorEvent.addEventListener((error) => {
                        console.warn('[Geofences] Ion imagery error:', error);
                    });
                    const ionLayer = viewer.imageryLayers.addImageryProvider(ionProvider);
                    viewer.imageryLayers.raiseToTop(ionLayer);
                    console.log(`[Geofences] Cesium Ion imagery loaded (asset ${CONFIG.ION_BASE_IMAGERY_ASSET_ID})`);
                } catch (error) {
                    console.warn('[Geofences] Failed to load Ion imagery; keeping Esri imagery:', error);
                }
            }

            try {
                viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
                console.log('[Geofences] Cesium World Terrain loaded');
            } catch (error) {
                console.warn('[Geofences] Failed to load World Terrain; using ellipsoid terrain:', error);
            }
        }

        // Load Google Photorealistic 3D Tiles (optional)
        if (CONFIG.CESIUM_ION_TOKEN && CONFIG.GOOGLE_3D_TILES_ASSET_ID) {
            try {
                const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID, {
                    showOutline: false,
                    enableShowOutline: false
                });
                tileset.showOutline = false;
                viewer.scene.primitives.add(tileset);
                console.log('[Geofences] Google 3D Tiles loaded');
            } catch (e) {
                console.error('[Geofences] Failed to load 3D tiles:', e);
            }
        }

        if (window.ATCCameraControls && typeof window.ATCCameraControls.attach === 'function') {
            window.ATCCameraControls.attach(viewer);
        }

        // Set initial view
        resetView();

        console.log('[Geofences] Viewer initialized');
    }

    async function loadGeofences() {
        try {
            const data = await API.getGeofences();
            lastLoadError = null;
            geofences = Array.isArray(data) ? data : [];
            renderGeofences();
            return;
        } catch (error) {
            console.error('[Geofences] Failed to load geofences:', error);
            lastLoadError = 'Unable to reach the ATC backend.';
        }
        geofences = [];
        renderGeofences();
    }

    function renderGeofences() {
        clearGeofenceEntities();
        updateStats();
        renderGeofenceList();

        geofences.forEach((gf) => {
            const positions = gf.polygon.map(([lat, lon]) => [lon, lat]).flat();
            const colors = getGeofenceColors(gf.geofence_type);
            const sourceLabel = formatSourceLabel(gf.source || 'local');
            const createdAtLabel = (() => {
                if (!gf.created_at) return '--';
                const date = new Date(gf.created_at);
                return Number.isNaN(date.valueOf()) ? String(gf.created_at) : date.toLocaleString();
            })();
            const entity = viewer.entities.add({
                id: gf.id,
                name: gf.name,
                show: gf.active !== false,
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                    height: gf.lower_altitude_m || 0,
                    extrudedHeight: gf.upper_altitude_m || 0,
                    material: colors.fill,
                    outline: true,
                    outlineColor: colors.outline,
                    outlineWidth: 2
                },
                description: `
                    <table class="cesium-infoBox-defaultTable">
                        <tr><td>Source:</td><td>${escapeHtml(sourceLabel)}</td></tr>
                        <tr><td>Created:</td><td>${escapeHtml(createdAtLabel)}</td></tr>
                        <tr><td>Type:</td><td>${formatTypeLabel(gf.geofence_type)}</td></tr>
                        <tr><td>Altitude:</td><td>${gf.lower_altitude_m || 0}m - ${gf.upper_altitude_m || 0}m AGL</td></tr>
                    </table>
                `
            });

            geofenceEntities.set(gf.id, { entity, data: gf, filterType: mapFilterType(gf.geofence_type) });
        });

        applyFilter(activeFilter);
    }

    function clearGeofenceEntities() {
        geofenceEntities.forEach((entry) => viewer.entities.remove(entry.entity));
        geofenceEntities.clear();
    }

    function updateStats() {
        const totalEl = document.getElementById('geofenceTotal');
        const noFlyEl = document.getElementById('geofenceNoFly');
        const externalEl = document.getElementById('geofenceExternal');
        if (lastLoadError) {
            if (totalEl) totalEl.textContent = '--';
            if (noFlyEl) noFlyEl.textContent = '--';
            if (externalEl) externalEl.textContent = '--';
            return;
        }
        const active = geofences.filter((gf) => gf.active !== false);
        const total = active.length;
        const noFly = active.filter((gf) => gf.geofence_type === 'no_fly_zone').length;
        const external = active.filter((gf) => (gf.source || 'local') === 'blender').length;
        if (totalEl) totalEl.textContent = total.toString();
        if (noFlyEl) noFlyEl.textContent = noFly.toString();
        if (externalEl) externalEl.textContent = external.toString();
    }

    function renderGeofenceList() {
        const container = document.getElementById('geofenceList');
        if (!container) return;

        if (lastLoadError) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 12px;">
                    <div class="empty-state-text text-muted">${escapeHtml(lastLoadError)}</div>
                </div>
            `;
            return;
        }

        if (!geofences.length) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 12px;">
                    <div class="empty-state-text text-muted">No geofences available</div>
                </div>
            `;
            return;
        }

        container.innerHTML = geofences.map((gf) => {
            const filterType = mapFilterType(gf.geofence_type);
            const colors = getGeofenceColors(gf.geofence_type);
            const label = formatTypeLabel(gf.geofence_type);
            const statusLabel = gf.active === false ? 'Inactive' : 'Active';
            const source = gf.source || 'local';
            const sourceLabel = formatSourceLabel(source);
            const isExternal = source === 'blender';
            const actionButtons = (canManage && !isExternal)
                ? `
                    <div class="flex gap-sm">
                        <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${escapeHtml(gf.id)}">
                            ${gf.active === false ? 'Enable' : 'Disable'}
                        </button>
                        <button class="btn btn-danger btn-sm" data-action="remove" data-id="${escapeHtml(gf.id)}">
                            Delete
                        </button>
                    </div>
                `
                : '';
            return `
                <div class="geofence-item" data-type="${escapeHtml(filterType)}" data-id="${escapeHtml(gf.id)}">
                    <span class="status-dot" style="background: ${colors.dot};"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">${escapeHtml(gf.name)}</div>
                        <div class="list-item-subtitle">${escapeHtml(label)} | ${escapeHtml(gf.lower_altitude_m || 0)}-${escapeHtml(gf.upper_altitude_m || 0)}m | ${escapeHtml(statusLabel)} | ${escapeHtml(sourceLabel)}</div>
                    </div>
                    ${actionButtons}
                </div>
            `;
        }).join('');

        container.querySelectorAll('.geofence-item').forEach((item) => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                if (id) {
                    GeofenceControl.focus(id);
                }
            });
        });

        container.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = btn.dataset.id;
                if (id) {
                    GeofenceControl.toggle(id);
                }
            });
        });

        container.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = btn.dataset.id;
                if (id) {
                    GeofenceControl.remove(id);
                }
            });
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

    function mapFilterType(type) {
        switch (type) {
            case 'no_fly_zone':
                return 'no_fly';
            case 'restricted_area':
                return 'restricted';
            case 'temporary_restriction':
                return 'temporary';
            default:
                return 'all';
        }
    }

    function formatTypeLabel(type) {
        switch (type) {
            case 'no_fly_zone':
                return 'No-Fly Zone';
            case 'restricted_area':
                return 'Restricted';
            case 'temporary_restriction':
                return 'Temporary';
            case 'advisory':
                return 'Advisory';
            default:
                return 'Geofence';
        }
    }

    function formatSourceLabel(source) {
        switch (String(source || '').toLowerCase()) {
            case 'blender':
                return 'Blender';
            case 'local':
            default:
                return 'Local';
        }
    }

    function getGeofenceColors(type) {
        switch (type) {
            case 'no_fly_zone':
                return { fill: Cesium.Color.RED.withAlpha(0.2), outline: Cesium.Color.RED, dot: 'var(--accent-red)' };
            case 'restricted_area':
                return { fill: Cesium.Color.YELLOW.withAlpha(0.2), outline: Cesium.Color.YELLOW, dot: 'var(--accent-yellow)' };
            case 'temporary_restriction':
                return { fill: Cesium.Color.CYAN.withAlpha(0.2), outline: Cesium.Color.CYAN, dot: 'var(--accent-cyan)' };
            case 'advisory':
                return { fill: Cesium.Color.BLUE.withAlpha(0.15), outline: Cesium.Color.BLUE, dot: 'var(--accent-blue)' };
            default:
                return { fill: Cesium.Color.BLUE.withAlpha(0.15), outline: Cesium.Color.BLUE, dot: 'var(--accent-blue)' };
        }
    }

    function applyFilter(type) {
        activeFilter = type;

        document.querySelectorAll('.geofence-item').forEach((el) => {
            el.style.display = (type === 'all' || el.dataset.type === type) ? 'flex' : 'none';
        });

        document.querySelectorAll('[data-filter]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.filter === type);
        });

        geofenceEntities.forEach((entry) => {
            const isActive = entry.data?.active !== false;
            entry.entity.show = (type === 'all' || entry.filterType === type) && isActive;
        });
    }

    function filterGeofences(type) {
        applyFilter(type);
    }

    async function toggleActive(id) {
        const target = geofences.find((gf) => gf.id === id);
        if (!target) return;
        if ((target.source || 'local') === 'blender') return;
        const nextActive = !(target.active !== false);
        try {
            const updated = await API.updateGeofence(id, { active: nextActive });
            geofences = geofences.map((gf) => (gf.id === id ? updated : gf));
            renderGeofences();
        } catch (error) {
            console.error('[Geofences] Failed to update geofence:', error);
        }
    }

    async function removeGeofence(id) {
        if (!confirm('Delete this geofence?')) return;
        const target = geofences.find((gf) => gf.id === id);
        if (target && (target.source || 'local') === 'blender') return;
        try {
            await API.deleteGeofence(id);
            geofences = geofences.filter((gf) => gf.id !== id);
            renderGeofences();
        } catch (error) {
            console.error('[Geofences] Failed to delete geofence:', error);
        }
    }

    // ========================================================================
    // Global API
    // ========================================================================

    window.GeofenceControl = {
        focus: focusGeofence,
        filter: filterGeofences,
        reset: resetView,
        toggle: toggleActive,
        remove: removeGeofence
    };

    // ========================================================================
    // Bootstrap
    // ========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('button[data-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const filterType = btn.dataset.filter;
                if (filterType) {
                    filterGeofences(filterType);
                }
            });
        });
        const resetBtn = document.getElementById('geofenceResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', resetView);
        }
        initViewer().then(loadGeofences);
    });

})();
