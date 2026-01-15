/**
 * Safe Corridor Height Calculator with FAA Compliance
 * 
 * Calculates the maximum obstacle height along a drone route using
 * Cesium OSM Buildings (Asset ID: 96188) for pre-flight conflict detection,
 * and validates against FAA Part 107 altitude restrictions.
 * 
 * LEGAL CONSTRAINTS:
 * - Height math MUST use OSM Buildings, NOT Google 3D Tiles
 * - Maximum legal altitude: 400ft AGL (~121m) per FAA Part 107
 * 
 * @module safe-corridor
 */

(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD)
    // Supports CommonJS, AMD, and browser globals
    if (typeof module === 'object' && module.exports) {
        // CommonJS (Node.js, Webpack, etc.)
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD (RequireJS)
        define([], factory);
    } else {
        // Browser global
        var exports = factory();
        root.SafeCorridor = exports;
        // Also expose main functions directly for console convenience
        root.calculateSafeCorridorHeight = exports.calculateSafeCorridorHeight;
        root.validateFlightPath = exports.validateFlightPath;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ============================================================================
    // Configuration
    // ============================================================================

    var OSM_BUILDINGS_ASSET_ID = 96188;
    var DEFAULT_SAFETY_BUFFER_M = 15;
    var DEFAULT_SAMPLE_SPACING_M = 5;
    var TILESET_LOAD_TIMEOUT_MS = 10000;

    // FAA Part 107 Regulations
    var FAA_MAX_ALTITUDE_AGL_M = 121; // ~400 feet Above Ground Level

    // Module-level cache for the OSM Buildings tileset
    var osmBuildingsTileset = null;
    var osmTilesetPromise = null;

    // ============================================================================
    // Utility Functions
    // ============================================================================

    /**
     * Creates a timeout promise for race conditions.
     * @param {number} ms - Timeout in milliseconds
     * @param {string} message - Error message on timeout
     * @returns {Promise} Promise that rejects after timeout
     */
    function createTimeout(ms, message) {
        return new Promise(function (_, reject) {
            setTimeout(function () {
                reject(new Error(message || 'Operation timed out after ' + ms + 'ms'));
            }, ms);
        });
    }

    // ============================================================================
    // Tileset Management
    // ============================================================================

    /**
     * Loads and caches the OSM Buildings tileset.
     * The tileset is loaded with show: false to avoid visual clutter.
     * 
     * Includes a 10-second timeout to prevent hanging if Cesium Ion is unreachable.
     * 
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     * @returns {Promise<Cesium.Cesium3DTileset>} The loaded tileset
     * @throws {Error} If loading fails or times out
     */
    function getOsmBuildingsTileset(viewer) {
        // Return cached tileset if available
        if (osmBuildingsTileset) {
            return Promise.resolve(osmBuildingsTileset);
        }

        // Return existing promise if load is in progress
        if (osmTilesetPromise) {
            return osmTilesetPromise;
        }

        // Start loading with timeout protection
        osmTilesetPromise = Promise.race([
            // Actual tileset loading
            (function () {
                console.log('[SafeCorridor] Loading OSM Buildings tileset (Asset 96188)...');

                return Cesium.Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID)
                    .then(function (tileset) {
                        // Hide tileset - we only use it for height sampling, not display
                        tileset.show = false;

                        // Add to scene primitives for sampleHeightMostDetailed to work
                        viewer.scene.primitives.add(tileset);

                        // Cache for future calls
                        osmBuildingsTileset = tileset;

                        console.log('[SafeCorridor] OSM Buildings tileset loaded successfully');
                        return tileset;
                    });
            })(),

            // Timeout protection
            createTimeout(
                TILESET_LOAD_TIMEOUT_MS,
                '[SafeCorridor] OSM Buildings tileset load timed out after ' +
                (TILESET_LOAD_TIMEOUT_MS / 1000) + ' seconds. Check Cesium Ion connectivity.'
            )
        ]).catch(function (error) {
            console.error('[SafeCorridor] Failed to load OSM Buildings tileset:', error);
            osmTilesetPromise = null; // Allow retry on failure
            throw error;
        });

        return osmTilesetPromise;
    }

    // ============================================================================
    // Geometry Utilities
    // ============================================================================

    /**
     * Calculates the distance between two Cartographic positions in meters.
     * Uses geodesic calculation for accuracy on Earth's surface.
     * 
     * @param {Cesium.Cartographic} c1 - First position
     * @param {Cesium.Cartographic} c2 - Second position
     * @returns {number} Distance in meters
     */
    function cartographicDistance(c1, c2) {
        var ellipsoid = Cesium.Ellipsoid.WGS84;
        var geodesic = new Cesium.EllipsoidGeodesic(c1, c2, ellipsoid);
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

        var result = [];

        for (var i = 0; i < waypoints.length - 1; i++) {
            var start = waypoints[i];
            var end = waypoints[i + 1];

            // Always include the start point
            result.push(start.clone());

            // Calculate segment distance
            var distance = cartographicDistance(start, end);

            if (distance <= spacingMeters) {
                // Segment is short enough, no interpolation needed
                continue;
            }

            // Calculate number of intermediate points
            var numSegments = Math.ceil(distance / spacingMeters);

            // Use geodesic for accurate interpolation on Earth's surface
            var geodesic = new Cesium.EllipsoidGeodesic(start, end, Cesium.Ellipsoid.WGS84);

            for (var j = 1; j < numSegments; j++) {
                var fraction = j / numSegments;
                var interpolated = geodesic.interpolateUsingSurfaceDistance(
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
    // FAA Compliance Logic
    // ============================================================================

    /**
     * Validates a flight path against FAA Part 107 altitude restrictions.
     * 
     * FAA Part 107 limits drone flights to 400ft (~121m) Above Ground Level (AGL).
     * This function checks if flying at the minimum safe altitude (building height + 
     * safety buffer) would violate this restriction.
     * 
     * @param {Cesium.Cartographic[]} sampledPositions - Array of positions with sampled heights
     * @param {Object} [options={}] - Validation options
     * @param {number} [options.safetyBuffer=15] - Safety buffer in meters above obstacles
     * @param {number} [options.maxLegalAltitude=121] - FAA max altitude AGL in meters
     * @returns {Object} Validation result
     * @returns {boolean} result.isValid - True if flight is legal at safe altitude
     * @returns {number} result.suggestedAltitude - Recommended flight altitude in meters
     * @returns {Array} result.violationSegments - Points where buildings are too tall
     * @returns {number} result.maxObstacleHeight - Highest obstacle encountered
     * @returns {string} result.summary - Human-readable summary
     */
    function validateFlightPath(sampledPositions, options) {
        options = options || {};
        var safetyBuffer = options.safetyBuffer !== undefined ? options.safetyBuffer : DEFAULT_SAFETY_BUFFER_M;
        var maxLegalAltitude = options.maxLegalAltitude !== undefined ? options.maxLegalAltitude : FAA_MAX_ALTITUDE_AGL_M;

        var violationSegments = [];
        var maxObstacleHeight = 0;
        var validSamples = 0;

        // Process each sampled point
        for (var i = 0; i < sampledPositions.length; i++) {
            var position = sampledPositions[i];
            var obstacleHeight = 0;

            // Get obstacle height (OSM building height or 0 if no data)
            if (position.height !== undefined && !isNaN(position.height) && position.height > 0) {
                obstacleHeight = position.height;
                validSamples++;
            }
            // NOTE: If viewer.scene.globe is false (as in spotlight.ejs with Google 3D Tiles),
            // we cannot query terrain height. In this case, we assume Terrain Height = 0 
            // (Sea Level) as the base reference. This is acceptable for urban areas where
            // OSM Buildings provides the critical obstacle data. For rural or mountainous
            // routes, consider enabling globe or using a separate terrain provider.

            // Track maximum obstacle
            maxObstacleHeight = Math.max(maxObstacleHeight, obstacleHeight);

            // Calculate minimum safe altitude for this point
            var minSafeAltitude = obstacleHeight + safetyBuffer;

            // Check FAA violation: Can we legally fly above this obstacle?
            if (minSafeAltitude > maxLegalAltitude) {
                violationSegments.push({
                    index: i,
                    longitude: Cesium.Math.toDegrees(position.longitude),
                    latitude: Cesium.Math.toDegrees(position.latitude),
                    obstacleHeight: obstacleHeight,
                    requiredAltitude: minSafeAltitude,
                    exceedsLegalBy: minSafeAltitude - maxLegalAltitude
                });
            }
        }

        // Calculate suggested flight altitude
        var suggestedAltitude = maxObstacleHeight + safetyBuffer;
        var isValid = violationSegments.length === 0;

        // Generate human-readable summary
        var summary;
        if (isValid) {
            summary = 'APPROVED: Flight path is legal. Suggested altitude: ' +
                suggestedAltitude.toFixed(1) + 'm (' +
                (suggestedAltitude * 3.28084).toFixed(0) + 'ft AGL)';
        } else {
            summary = 'DENIED: ' + violationSegments.length + ' segment(s) exceed FAA 400ft limit. ' +
                'Highest obstacle: ' + maxObstacleHeight.toFixed(1) + 'm requires ' +
                suggestedAltitude.toFixed(1) + 'm clearance (legal max: ' +
                maxLegalAltitude + 'm). Consider rerouting.';
        }

        console.log('[SafeCorridor] FAA Validation:', summary);

        return {
            isValid: isValid,
            suggestedAltitude: suggestedAltitude,
            violationSegments: violationSegments,
            maxObstacleHeight: maxObstacleHeight,
            maxLegalAltitude: maxLegalAltitude,
            safetyBuffer: safetyBuffer,
            sampledPoints: sampledPositions.length,
            validSamples: validSamples,
            summary: summary
        };
    }

    // ============================================================================
    // Main API
    // ============================================================================

    /**
     * Calculates the safe corridor height for a drone route and validates FAA compliance.
     * 
     * This function:
     * 1. Loads OSM Buildings tileset (cached after first call, 10s timeout)
     * 2. Converts route positions to Cartographic
     * 3. Interpolates waypoints at configured spacing (default 5m)
     * 4. Samples heights using sampleHeightMostDetailed against OSM Buildings
     * 5. Validates against FAA Part 107 altitude restrictions
     * 6. Returns comprehensive result with safety and compliance data
     * 
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     * @param {Cesium.Cartesian3[]} routePositions - Array of waypoint positions
     * @param {Object} [options={}] - Configuration options
     * @param {number} [options.safetyBuffer=15] - Safety buffer in meters to add
     * @param {number} [options.sampleSpacing=5] - Distance between samples in meters
     * @param {boolean} [options.debug=false] - If true, draws debug visualization
     * @param {boolean} [options.skipFaaValidation=false] - If true, skip FAA check
     * @returns {Promise<Object>} Result object with height and compliance data
     */
    function calculateSafeCorridorHeight(viewer, routePositions, options) {
        options = options || {};
        var safetyBuffer = options.safetyBuffer !== undefined ? options.safetyBuffer : DEFAULT_SAFETY_BUFFER_M;
        var sampleSpacing = options.sampleSpacing !== undefined ? options.sampleSpacing : DEFAULT_SAMPLE_SPACING_M;
        var debug = options.debug || false;
        var skipFaaValidation = options.skipFaaValidation || false;

        // Handle empty route
        if (!routePositions || routePositions.length === 0) {
            console.warn('[SafeCorridor] Empty route provided');
            return Promise.resolve({
                maxHeight: safetyBuffer,
                sampleCount: 0,
                osmTileset: null,
                faaValidation: skipFaaValidation ? null : {
                    isValid: true,
                    suggestedAltitude: safetyBuffer,
                    violationSegments: [],
                    summary: 'Empty route - no obstacles'
                }
            });
        }

        var ellipsoid = Cesium.Ellipsoid.WGS84;
        var waypoints;
        var samplePoints;
        var osmTileset;

        // Load OSM Buildings tileset (or get cached)
        return getOsmBuildingsTileset(viewer)
            .then(function (tileset) {
                osmTileset = tileset;

                // Convert Cartesian3 positions to Cartographic
                waypoints = routePositions.map(function (pos) {
                    return Cesium.Cartographic.fromCartesian(pos, ellipsoid);
                });

                // Interpolate to get dense sample points
                samplePoints = interpolateWaypoints(waypoints, sampleSpacing);

                console.log('[SafeCorridor] Sampling ' + samplePoints.length + ' points along route');

                // Sample heights using sampleHeightMostDetailed
                // This is the CORRECT async method that works with 3D Tiles
                // NOTE: This method MUTATES the input array, setting .height on each position
                return viewer.scene.sampleHeightMostDetailed(
                    samplePoints,
                    [osmTileset] // Only sample against OSM Buildings, not Google Tiles
                );
            })
            .then(function (sampledPositions) {
                // Find maximum height
                var maxHeight = 0;
                var validSamples = 0;

                for (var i = 0; i < sampledPositions.length; i++) {
                    var position = sampledPositions[i];
                    if (position.height !== undefined && !isNaN(position.height)) {
                        maxHeight = Math.max(maxHeight, position.height);
                        validSamples++;
                    }
                    // TERRAIN FALLBACK NOTE:
                    // If viewer.scene.globe is false (Google 3D Tiles mode), globe.getHeight()
                    // returns undefined. In this case, we assume terrain height = 0 (sea level).
                    // This is acceptable for urban areas where OSM Buildings is the primary
                    // obstacle source. For mountainous terrain, enable globe or use external
                    // terrain data.
                }

                console.log('[SafeCorridor] Valid samples: ' + validSamples + '/' + sampledPositions.length);
                console.log('[SafeCorridor] Max obstacle height: ' + maxHeight.toFixed(1) + 'm');

                // Add safety buffer for final height
                var safeHeight = maxHeight + safetyBuffer;
                console.log('[SafeCorridor] Safe corridor height (with ' + safetyBuffer + 'm buffer): ' + safeHeight.toFixed(1) + 'm');

                // Build result object
                var result = {
                    maxHeight: safeHeight,
                    maxObstacleHeight: maxHeight,
                    sampleCount: sampledPositions.length,
                    validSamples: validSamples,
                    osmTileset: osmTileset,
                    sampledPositions: sampledPositions
                };

                // FAA Compliance Validation
                if (!skipFaaValidation) {
                    result.faaValidation = validateFlightPath(sampledPositions, {
                        safetyBuffer: safetyBuffer
                    });
                }

                // Debug Visualization
                if (debug) {
                    // Remove previous debug entity if exists
                    var existingDebug = viewer.entities.getById('safe-corridor-debug');
                    if (existingDebug) {
                        viewer.entities.remove(existingDebug);
                    }

                    // Determine color based on FAA validation
                    var lineColor = Cesium.Color.GREEN;
                    if (result.faaValidation && !result.faaValidation.isValid) {
                        lineColor = Cesium.Color.RED;
                    }

                    // Create positions at safe height
                    var debugPositions = waypoints.map(function (wp) {
                        return Cesium.Cartesian3.fromRadians(wp.longitude, wp.latitude, safeHeight);
                    });

                    var debugEntity = viewer.entities.add({
                        id: 'safe-corridor-debug',
                        name: 'Safe Corridor Height',
                        polyline: {
                            positions: debugPositions,
                            width: 5,
                            material: new Cesium.PolylineGlowMaterialProperty({
                                glowPower: 0.3,
                                color: lineColor
                            }),
                            clampToGround: false
                        },
                        description: 'Safe Height: ' + safeHeight.toFixed(1) + 'm (includes ' +
                            safetyBuffer + 'm buffer)<br>' +
                            (result.faaValidation ? result.faaValidation.summary : '')
                    });

                    result.debugEntity = debugEntity;
                    console.log('[SafeCorridor] Debug visualization enabled - ' +
                        (result.faaValidation && result.faaValidation.isValid ? 'GREEN' : 'RED') +
                        ' polyline at safe height');
                }

                return result;
            });
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
            console.log('[SafeCorridor] OSM Buildings visibility: ' + visible);
        } else {
            console.warn('[SafeCorridor] OSM Buildings tileset not loaded yet');
        }
    }

    // ============================================================================
    // Module Exports
    // ============================================================================

    return {
        // Main API
        calculateSafeCorridorHeight: calculateSafeCorridorHeight,
        validateFlightPath: validateFlightPath,

        // Tileset Management
        getOsmBuildingsTileset: getOsmBuildingsTileset,
        clearOsmBuildingsCache: clearOsmBuildingsCache,
        setOsmBuildingsVisible: setOsmBuildingsVisible,

        // Configuration Constants
        OSM_BUILDINGS_ASSET_ID: OSM_BUILDINGS_ASSET_ID,
        DEFAULT_SAFETY_BUFFER_M: DEFAULT_SAFETY_BUFFER_M,
        DEFAULT_SAMPLE_SPACING_M: DEFAULT_SAMPLE_SPACING_M,
        FAA_MAX_ALTITUDE_AGL_M: FAA_MAX_ALTITUDE_AGL_M,
        TILESET_LOAD_TIMEOUT_MS: TILESET_LOAD_TIMEOUT_MS
    };

});
