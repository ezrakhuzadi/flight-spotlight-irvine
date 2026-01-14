/**
 * Conflict Detection Helper for Flight Spotlight
 * 
 * Detects when drones are on converging paths or violating
 * separation minimums.
 */

const SEPARATION_HORIZONTAL_M = 50;  // meters
const SEPARATION_VERTICAL_M = 30;    // meters
const WARNING_MULTIPLIER = 2.0;

/**
 * Calculate haversine distance between two points in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dphi = (lat2 - lat1) * Math.PI / 180;
    const dlambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dphi / 2) * Math.sin(dphi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(dlambda / 2) * Math.sin(dlambda / 2);

    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check all drone pairs for conflicts
 * @param {Array} observations - Array of drone observations from Tile38
 * @returns {Array} - Array of detected conflicts
 */
function detectConflicts(observations) {
    const conflicts = [];

    if (!observations || observations.length < 2) {
        return conflicts;
    }

    // Check all pairs
    for (let i = 0; i < observations.length; i++) {
        for (let j = i + 1; j < observations.length; j++) {
            const drone1 = observations[i];
            const drone2 = observations[j];

            // Extract positions (Tile38 returns [lon, lat, alt])
            const coords1 = drone1.object?.coordinates || [];
            const coords2 = drone2.object?.coordinates || [];

            if (coords1.length < 2 || coords2.length < 2) continue;

            const lat1 = coords1[1], lon1 = coords1[0];
            const lat2 = coords2[1], lon2 = coords2[0];
            const alt1 = (coords1[2] || 0) / 1000; // mm to m
            const alt2 = (coords2[2] || 0) / 1000;

            // Calculate separation
            const hDist = haversineDistance(lat1, lon1, lat2, lon2);
            const vDist = Math.abs(alt1 - alt2);

            // Check for violations
            let severity = null;
            if (hDist < SEPARATION_HORIZONTAL_M && vDist < SEPARATION_VERTICAL_M) {
                severity = 'critical';
            } else if (hDist < SEPARATION_HORIZONTAL_M * WARNING_MULTIPLIER &&
                vDist < SEPARATION_VERTICAL_M * WARNING_MULTIPLIER) {
                severity = 'warning';
            }

            if (severity) {
                conflicts.push({
                    drone1_id: drone1.id,
                    drone2_id: drone2.id,
                    severity: severity,
                    horizontal_distance_m: Math.round(hDist),
                    vertical_distance_m: Math.round(vDist),
                    timestamp: Date.now()
                });
                console.log(`[Conflict] ${severity.toUpperCase()}: ${drone1.id} <-> ${drone2.id} (${Math.round(hDist)}m horizontal, ${Math.round(vDist)}m vertical)`);
            }
        }
    }

    return conflicts;
}

module.exports = {
    detectConflicts,
    haversineDistance,
    SEPARATION_HORIZONTAL_M,
    SEPARATION_VERTICAL_M
};
