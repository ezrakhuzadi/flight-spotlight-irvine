/**
 * Safe Corridor Height Calculator
 * 
 * Calculates the maximum obstacle height along a drone route using
 * Cesium OSM Buildings (Asset ID: 96188) for pre-flight conflict detection.
 * 
 * LEGAL CONSTRAINT: Height math MUST use OSM Buildings, NOT Google 3D Tiles.
 * Google tiles are for display only.
 * 
 * @module safe-corridor
 */

// ============================================================================
// Configuration
// ============================================================================

const OSM_BUILDINGS_ASSET_ID = 96188;
const DEFAULT_SAFETY_BUFFER_M = 15;
const DEFAULT_SAMPLE_SPACING_M = 5;

// Module-level cache for the OSM Buildings tileset
let osmBuildingsTileset = null;
let osmTilesetPromise = null;

// ============================================================================
// Tileset Management
// ============================================================================

/**
 * Loads and caches the OSM Buildings tileset.
 * The tileset is loaded with show: false to avoid visual clutter.
 * 
 * @param {Cesium.Viewer} viewer - The Cesium viewer instance
 * @returns {Promise<Cesium.Cesium3DTileset>} The loaded tileset
 */
async function getOsmBuildingsTileset(viewer) {
    // Return cached tileset if available
    if (osmBuildingsTileset) {
        return osmBuildingsTileset;
    }

    // Return existing promise if load is in progress
    if (osmTilesetPromise) {
        return osmTilesetPromise;
    }

    // Start loading
    osmTilesetPromise = (async () => {
        try {
            console.log('[SafeCorridor] Loading OSM Buildings tileset (Asset 96188)...');

            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID);

            // Hide tileset - we only use it for height sampling, not display
            tileset.show = false;

            // Add to scene primitives for sampleHeightMostDetailed to work
            viewer.scene.primitives.add(tileset);

            // Cache for future calls
            osmBuildingsTileset = tileset;

            console.log('[SafeCorridor] OSM Buildings tileset loaded successfully');
            return tileset;
        } catch (error) {
            console.error('[SafeCorridor] Failed to load OSM Buildings tileset:', error);
            osmTilesetPromise = null; // Allow retry on failure
            throw error;
        }
    })();

    return osmTilesetPromise;
}

// ============================================================================
// Geometry Utilities
// ============================================================================

/**
 * Calculates the distance between two Cartographic positions in meters.
 * Uses the Haversine formula for accuracy.
 * 
 * @param {Cesium.Cartographic} c1 - First position
 * @param {Cesium.Cartographic} c2 - Second position
 * @returns {number} Distance in meters
 */
function cartographicDistance(c1, c2) {
    const ellipsoid = Cesium.Ellipsoid.WGS84;
    const geodesic = new Cesium.EllipsoidGeodesic(c1, c2, ellipsoid);
    return geodesic.surfaceDistance;
}

/**
 * Interpolates points along a route at specified spacing to ensure
 * we don't miss thin buildings between waypoints.
 * 
 * @param {Cesium.Cartographic[]} waypoints - Original waypoints
 * @param {number} spacingMeters - Distance between interpolated points
 * @returns {Cesium.Cartographic[]} Dense array of sample points
 */
function interpolateWaypoints(waypoints, spacingMeters) {
    if (waypoints.length === 0) {
        return [];
    }

    if (waypoints.length === 1) {
        return [waypoints[0].clone()];
    }

    const result = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
        const start = waypoints[i];
        const end = waypoints[i + 1];

        // Always include the start point
        result.push(start.clone());

        // Calculate segment distance
        const distance = cartographicDistance(start, end);

        if (distance <= spacingMeters) {
            // Segment is short enough, no interpolation needed
            continue;
        }

        // Calculate number of intermediate points
        const numSegments = Math.ceil(distance / spacingMeters);

        // Use geodesic for accurate interpolation on Earth's surface
        const geodesic = new Cesium.EllipsoidGeodesic(start, end, Cesium.Ellipsoid.WGS84);

        for (let j = 1; j < numSegments; j++) {
            const fraction = j / numSegments;
            const interpolated = geodesic.interpolateUsingSurfaceDistance(
                fraction * geodesic.surfaceDistance
            );
            result.push(interpolated);
        }
    }

    // Always include the final waypoint
    result.push(waypoints[waypoints.length - 1].clone());

    return result;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Calculates the safe corridor height for a drone route.
 * 
 * This function:
 * 1. Loads OSM Buildings tileset (cached after first call)
 * 2. Converts route positions to Cartographic
 * 3. Interpolates waypoints at configured spacing (default 5m)
 * 4. Samples heights using sampleHeightMostDetailed against OSM Buildings
 * 5. Falls back to terrain height where no building exists
 * 6. Returns max height + safety buffer
 * 
 * @param {Cesium.Viewer} viewer - The Cesium viewer instance
 * @param {Cesium.Cartesian3[]} routePositions - Array of waypoint positions
 * @param {Object} [options={}] - Configuration options
 * @param {number} [options.safetyBuffer=15] - Safety buffer in meters to add
 * @param {number} [options.sampleSpacing=5] - Distance between samples in meters
 * @param {boolean} [options.debug=false] - If true, draws debug visualization
 * @returns {Promise<{maxHeight: number, sampleCount: number, osmTileset: Cesium.Cesium3DTileset, debugEntity?: Cesium.Entity}>}
 */
async function calculateSafeCorridorHeight(viewer, routePositions, options = {}) {
    const safetyBuffer = options.safetyBuffer ?? DEFAULT_SAFETY_BUFFER_M;
    const sampleSpacing = options.sampleSpacing ?? DEFAULT_SAMPLE_SPACING_M;
    const debug = options.debug ?? false;

    // Handle empty route
    if (!routePositions || routePositions.length === 0) {
        console.warn('[SafeCorridor] Empty route provided');
        return {
            maxHeight: safetyBuffer,
            sampleCount: 0,
            osmTileset: null
        };
    }

    // Load OSM Buildings tileset (or get cached)
    const osmTileset = await getOsmBuildingsTileset(viewer);

    // Convert Cartesian3 positions to Cartographic
    const ellipsoid = Cesium.Ellipsoid.WGS84;
    const waypoints = routePositions.map(pos =>
        Cesium.Cartographic.fromCartesian(pos, ellipsoid)
    );

    // Interpolate to get dense sample points
    const samplePoints = interpolateWaypoints(waypoints, sampleSpacing);

    console.log(`[SafeCorridor] Sampling ${samplePoints.length} points along route`);

    // Sample heights using sampleHeightMostDetailed
    // This is the CORRECT async method that works with 3D Tiles
    const sampledPositions = await viewer.scene.sampleHeightMostDetailed(
        samplePoints,
        [osmTileset] // Only sample against OSM Buildings, not Google Tiles
    );

    // Process results and find maximum height
    let maxHeight = 0;
    let validSamples = 0;

    for (const position of sampledPositions) {
        if (position.height !== undefined && !isNaN(position.height)) {
            // Valid height from OSM Buildings or terrain
            maxHeight = Math.max(maxHeight, position.height);
            validSamples++;
        } else {
            // Fallback: try to get terrain height
            // Note: This is a sync approximation, may not be accurate
            const terrainHeight = viewer.scene.globe?.getHeight(position);
            if (terrainHeight !== undefined && !isNaN(terrainHeight)) {
                maxHeight = Math.max(maxHeight, terrainHeight);
                validSamples++;
            }
        }
    }

    console.log(`[SafeCorridor] Valid samples: ${validSamples}/${sampledPositions.length}`);
    console.log(`[SafeCorridor] Max obstacle height: ${maxHeight.toFixed(1)}m`);

    // Add safety buffer
    const safeHeight = maxHeight + safetyBuffer;
    console.log(`[SafeCorridor] Safe corridor height (with ${safetyBuffer}m buffer): ${safeHeight.toFixed(1)}m`);

    const result = {
        maxHeight: safeHeight,
        sampleCount: sampledPositions.length,
        osmTileset: osmTileset
    };

    // ========================================================================
    // Debug Visualization (Optional)
    // Draws a red polyline at the calculated safe height
    // ========================================================================
    if (debug) {
        // Remove previous debug entity if exists
        const existingDebug = viewer.entities.getById('safe-corridor-debug');
        if (existingDebug) {
            viewer.entities.remove(existingDebug);
        }

        // Create positions at safe height
        const debugPositions = waypoints.map(wp =>
            Cesium.Cartesian3.fromRadians(wp.longitude, wp.latitude, safeHeight)
        );

        const debugEntity = viewer.entities.add({
            id: 'safe-corridor-debug',
            name: 'Safe Corridor Height',
            polyline: {
                positions: debugPositions,
                width: 5,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.3,
                    color: Cesium.Color.RED
                }),
                clampToGround: false
            },
            description: `Safe Height: ${safeHeight.toFixed(1)}m (includes ${safetyBuffer}m buffer)`
        });

        result.debugEntity = debugEntity;
        console.log('[SafeCorridor] Debug visualization enabled - red polyline at safe height');
    }

    return result;
}

/**
 * Clears the cached OSM Buildings tileset.
 * Call this if you need to force a reload.
 * 
 * @param {Cesium.Viewer} viewer - The Cesium viewer instance
 */
function clearOsmBuildingsCache(viewer) {
    if (osmBuildingsTileset) {
        viewer.scene.primitives.remove(osmBuildingsTileset);
        osmBuildingsTileset = null;
        osmTilesetPromise = null;
        console.log('[SafeCorridor] OSM Buildings cache cleared');
    }
}

/**
 * Shows or hides the OSM Buildings tileset for debugging.
 * 
 * @param {boolean} visible - Whether to show the tileset
 */
function setOsmBuildingsVisible(visible) {
    if (osmBuildingsTileset) {
        osmBuildingsTileset.show = visible;
        console.log(`[SafeCorridor] OSM Buildings visibility: ${visible}`);
    } else {
        console.warn('[SafeCorridor] OSM Buildings tileset not loaded yet');
    }
}

// ============================================================================
// Exports (for ES modules) and Global Registration (for script tags)
// ============================================================================

// Make available globally for non-module usage (e.g., browser console)
if (typeof window !== 'undefined') {
    window.SafeCorridor = {
        calculateSafeCorridorHeight,
        clearOsmBuildingsCache,
        setOsmBuildingsVisible,
        getOsmBuildingsTileset
    };

    // Also expose the main function directly for convenience
    window.calculateSafeCorridorHeight = calculateSafeCorridorHeight;
}

// ES Module exports
export {
    calculateSafeCorridorHeight,
    clearOsmBuildingsCache,
    setOsmBuildingsVisible,
    getOsmBuildingsTileset,
    OSM_BUILDINGS_ASSET_ID,
    DEFAULT_SAFETY_BUFFER_M,
    DEFAULT_SAMPLE_SPACING_M
};
