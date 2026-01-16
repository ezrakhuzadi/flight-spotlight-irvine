/**
 * API Client - ATC Server Interface
 * Wrapper for all ATC-Drone server communication
 */

const API = (function () {
    'use strict';

    // Configuration
    const ATC_SERVER_URL = 'http://localhost:3000';

    // State
    let lastUpdate = null;

    /**
     * Make an API request
     */
    async function request(endpoint, options = {}) {
        const url = `${ATC_SERVER_URL}${endpoint}`;

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            lastUpdate = new Date();
            updateLastUpdateUI();

            return await response.json();
        } catch (error) {
            console.error(`[API] ${endpoint} failed:`, error);
            throw error;
        }
    }

    /**
     * Update status bar timestamp
     */
    function updateLastUpdateUI() {
        const el = document.getElementById('lastUpdateTime');
        if (el && lastUpdate) {
            const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
            el.textContent = seconds < 5 ? 'just now' : `${seconds}s ago`;
        }
    }

    // Update timestamp every second
    setInterval(updateLastUpdateUI, 1000);

    // ========================================
    // API Methods
    // ========================================

    return {
        // Drones - optionally filter by owner
        getDrones: (ownerId = null) => {
            const url = ownerId ? `/v1/drones?owner_id=${ownerId}` : '/v1/drones';
            return request(url);
        },
        getDrone: (id) => request(`/v1/drones/${id}`),

        // Commands
        sendCommand: (droneId, command) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({ drone_id: droneId, ...command })
        }),

        holdDrone: (droneId, duration = 30) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({
                drone_id: droneId,
                command_type: { Hold: { duration_secs: duration } }
            })
        }),

        resumeDrone: (droneId) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({
                drone_id: droneId,
                command_type: 'Resume'
            })
        }),

        // Conflicts
        getConflicts: () => request('/v1/conflicts'),

        // Geofences
        getGeofences: () => request('/v1/geofences'),

        // Stats (aggregated for dashboard)
        async getStats() {
            try {
                const [drones, conflicts, geofences] = await Promise.all([
                    this.getDrones().catch(() => []),
                    this.getConflicts().catch(() => []),
                    this.getGeofences().catch(() => [])
                ]);

                const online = drones.filter(d => d.status !== 'Lost').length;
                const flying = drones.filter(d => d.status === 'InFlight' || d.status === 'Rerouting').length;

                return {
                    dronesOnline: online,
                    dronesFlying: flying,
                    dronesTotal: drones.length,
                    conflicts: conflicts.length,
                    geofences: geofences.length,
                    drones: drones,
                    conflictData: conflicts
                };
            } catch (error) {
                console.error('[API] getStats failed:', error);
                return null;
            }
        },

        // Utility
        getLastUpdate: () => lastUpdate,
        getServerUrl: () => ATC_SERVER_URL
    };
})();

// Update status bar on load
document.addEventListener('DOMContentLoaded', () => {
    // Update drone count in status bar
    API.getStats().then(stats => {
        if (stats) {
            const droneCountEl = document.getElementById('droneCountValue');
            const conflictCountEl = document.getElementById('conflictCountValue');

            if (droneCountEl) droneCountEl.textContent = stats.dronesOnline;
            if (conflictCountEl) conflictCountEl.textContent = stats.conflicts;
        }
    }).catch(() => {
        // Server offline - that's ok
    });
});
