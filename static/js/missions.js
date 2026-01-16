/**
 * Missions Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 5000;

    /**
     * Load and display missions
     * For now, we derive "missions" from active drones since mission CRUD isn't implemented yet
     */
    async function loadMissions() {
        try {
            const drones = await API.getDrones();

            // Categorize drones as missions
            const active = drones.filter(d => d.status === 'InFlight' || d.status === 'Rerouting');
            const pending = []; // Would come from mission API
            const completed = []; // Would come from mission API

            renderMissionSection('activeMissions', active, 'active');
            renderMissionSection('pendingMissions', pending, 'pending');
            renderMissionSection('completedMissions', completed, 'completed');

        } catch (error) {
            console.error('[Missions] Load failed:', error);
        }
    }

    function renderMissionSection(containerId, missions, type) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!missions || missions.length === 0) {
            const emptyMessages = {
                active: 'No active missions',
                pending: 'No pending missions',
                completed: 'No completed missions today'
            };
            container.innerHTML = `
                <div class="empty-state" style="padding: 24px;">
                    <div class="empty-state-text text-muted">${emptyMessages[type]}</div>
                </div>
            `;
            return;
        }

        container.innerHTML = missions.map(mission => {
            // For now, missions are derived from flying drones
            const drone = mission; // mission IS a drone for now
            return `
                <div class="list-item">
                    <span class="status-dot flying"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">Flight: ${drone.drone_id}</div>
                        <div class="list-item-subtitle">
                            Position: ${drone.lat.toFixed(4)}, ${drone.lon.toFixed(4)} @ ${drone.altitude_m.toFixed(0)}m
                        </div>
                    </div>
                    ${type === 'active' ? `
                        <div class="list-item-actions">
                            <button class="btn btn-ghost btn-sm" onclick="window.location.href='/control/map?track=${drone.drone_id}'">
                                Track
                            </button>
                            <button class="btn btn-danger btn-sm" onclick="Missions.abort('${drone.drone_id}')">
                                Abort
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    async function abortMission(droneId) {
        if (!confirm(`Abort mission and land ${droneId}?`)) return;

        try {
            await API.holdDrone(droneId, 999);
            alert(`Abort command sent to ${droneId}`);
            loadMissions();
        } catch (error) {
            alert(`Failed to abort: ${error.message}`);
        }
    }

    function planNewMission() {
        // Placeholder - will open planner when integrated
        alert('Mission planner coming soon!\n\nFor now, use the standalone flight-planner app.');
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        loadMissions();
        setInterval(loadMissions, REFRESH_INTERVAL);

        // New mission button
        const newMissionBtn = document.getElementById('newMissionBtn');
        if (newMissionBtn) {
            newMissionBtn.addEventListener('click', planNewMission);
        }

        // Refresh button
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadMissions);
        }
    });

    // Export for global access
    window.Missions = {
        abort: abortMission,
        plan: planNewMission
    };
})();
