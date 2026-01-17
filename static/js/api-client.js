/**
 * API Client - ATC Server Interface
 * Wrapper for all ATC-Drone server communication
 */

const API = (function () {
    'use strict';

    // Configuration
    const ATC_SERVER_URL = window.__ATC_API_BASE__ || 'http://localhost:3000';

    // State
    let lastUpdate = null;

    /**
     * Make an API request
     */
    async function request(endpoint, options = {}) {
        const url = `${ATC_SERVER_URL}${endpoint}`;

        try {
            const response = await fetch(url, {
                credentials: 'same-origin',
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

    async function requestLocal(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, {
                credentials: 'same-origin',
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} ${errorText}`);
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
        registerDrone: (droneId = null, ownerId = null) => request('/v1/drones/register', {
            method: 'POST',
            body: JSON.stringify({
                drone_id: droneId || undefined,
                owner_id: ownerId || undefined
            })
        }),

        // Commands
        sendCommand: (droneId, command) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({ drone_id: droneId, ...command })
        }),

        holdDrone: (droneId, duration = 30) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({
                drone_id: droneId,
                type: 'HOLD',
                duration_secs: duration
            })
        }),

        resumeDrone: (droneId) => request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({
                drone_id: droneId,
                type: 'RESUME'
            })
        }),

        // Conflicts
        getConflicts: () => request('/v1/conflicts'),

        // Conformance
        getConformance: (ownerId = null) => {
            const url = ownerId ? `/v1/conformance?owner_id=${ownerId}` : '/v1/conformance';
            return request(url);
        },

        // Geofences
        getGeofences: () => request('/v1/geofences'),
        createGeofence: (payload) => request('/v1/geofences', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),

        // Flight Declarations (Flight Blender)
        getFlightDeclarations: async (params = {}) => {
            const search = new URLSearchParams(params);
            const endpoint = `/api/blender/flight-declarations${search.toString() ? `?${search}` : ''}`;
            const response = await requestLocal(endpoint);
            return response.results || response;
        },

        getFlightDeclaration: (id) => {
            const safeId = encodeURIComponent(id);
            return requestLocal(`/api/blender/flight-declarations/${safeId}`);
        },

        createFlightDeclaration: (payload) => requestLocal('/api/blender/flight-declarations', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),

        // Flight Plans (ATC-Drone)
        createFlightPlan: (payload) => request('/v1/flights/plan', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),
        getFlightPlans: () => request('/v1/flights'),

        // Compliance
        getComplianceWeather: (lat, lon) => {
            const params = new URLSearchParams({ lat, lon });
            return requestLocal(`/api/compliance/weather?${params.toString()}`);
        },

        // Stats (aggregated for dashboard)
        async getStats() {
            try {
                const [drones, conflicts, geofences, conformance] = await Promise.all([
                    this.getDrones().catch(() => []),
                    this.getConflicts().catch(() => []),
                    this.getGeofences().catch(() => []),
                    this.getConformance().catch(() => [])
                ]);

                const online = drones.filter(d => d.status !== 'Lost').length;
                const flying = drones.filter(d => d.status === 'InFlight' || d.status === 'Rerouting').length;
                const nonconforming = conformance.filter(c => c.status === 'nonconforming').length;

                return {
                    dronesOnline: online,
                    dronesFlying: flying,
                    dronesTotal: drones.length,
                    conflicts: conflicts.length,
                    geofences: geofences.length,
                    conformanceNoncompliant: nonconforming,
                    drones: drones,
                    conflictData: conflicts,
                    conformanceData: conformance
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
