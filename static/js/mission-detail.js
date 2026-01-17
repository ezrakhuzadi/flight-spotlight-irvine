/**
 * Mission Detail Page Logic
 */

(function () {
    'use strict';

    const STATE_LABELS = {
        0: 'Not Submitted',
        1: 'Accepted',
        2: 'Activated',
        3: 'Nonconforming',
        4: 'Contingent',
        5: 'Ended',
        6: 'Withdrawn',
        7: 'Cancelled',
        8: 'Rejected'
    };

    const OPERATION_TYPES = {
        1: 'VLOS',
        2: 'BVLOS',
        3: 'EVLOS',
        4: 'Experimental'
    };

    const container = document.getElementById('missionDetail');
    if (!container) return;

    const missionId = container.dataset.missionId;
    if (!missionId) {
        console.error('[MissionDetail] Missing mission ID');
        return;
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function formatDate(value) {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    }

    function getStatusClass(state) {
        if (state === 2 || state === 3 || state === 4) return 'flying';
        if (state === 5 || state === 6 || state === 7 || state === 8) return 'offline';
        return 'online';
    }

    function getConformanceClass(status) {
        switch (status) {
            case 'conforming':
                return 'pass';
            case 'nonconforming':
                return 'fail';
            default:
                return 'warn';
        }
    }

    function haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (deg) => deg * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function computeRouteDistance(waypoints) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
        let total = 0;
        for (let i = 0; i < waypoints.length - 1; i += 1) {
            total += haversineDistance(
                waypoints[i].lat,
                waypoints[i].lon,
                waypoints[i + 1].lat,
                waypoints[i + 1].lon
            );
        }
        return total;
    }

    function computeProgress(start, end) {
        if (!start || !end) return null;
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
        const now = Date.now();
        const ratio = Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)));
        return Math.round(ratio * 100);
    }

    async function loadMission() {
        let mission;
        try {
            mission = await API.getFlightDeclaration(missionId);
        } catch (error) {
            console.error('[MissionDetail] Failed to load mission:', error);
            setText('missionName', 'Unknown');
            return;
        }

        const [conformance, plans] = await Promise.all([
            API.getConformance().catch(() => []),
            API.getFlightPlans().catch(() => [])
        ]);

        const conformanceMap = new Map((conformance || []).map(entry => [entry.drone_id, entry]));

        const missionName = mission.originating_party || (mission.id ? `Mission ${mission.id.slice(0, 8)}` : 'Mission');
        setText('missionName', missionName);

        const statusLabel = STATE_LABELS[mission.state] || 'Unknown';
        const statusBadge = document.getElementById('missionStatus');
        const statusDot = container.querySelector('.status-dot');
        const statusClass = getStatusClass(mission.state);
        if (statusBadge) {
            statusBadge.textContent = statusLabel;
            statusBadge.className = `status-badge ${statusClass}`;
        }
        if (statusDot) {
            statusDot.className = `status-dot ${statusClass}`;
        }

        const typeLabel = OPERATION_TYPES[mission.type_of_operation] || `Type ${mission.type_of_operation ?? '--'}`;
        setText('droneId', mission.aircraft_id || '--');
        setText('missionType', typeLabel);
        setText('createdAt', formatDate(mission.created_at || mission.updated_at || mission.start_datetime));
        setText('startedAt', formatDate(mission.start_datetime));

        const progress = computeProgress(mission.start_datetime, mission.end_datetime);
        setText('progress', progress !== null ? `${progress}%` : '--');
        setText('eta', mission.end_datetime ? formatDate(mission.end_datetime) : '--');

        const plan = (plans || [])
            .filter(p => p.drone_id === mission.aircraft_id)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

        if (plan?.waypoints) {
            const distance = computeRouteDistance(plan.waypoints);
            setText('distance', distance !== null ? `${(distance / 1000).toFixed(2)} km` : '--');
            setText('waypoints', `${plan.waypoints.length} total`);
            if (plan.departure_time && plan.arrival_time) {
                const durationMs = Date.parse(plan.arrival_time) - Date.parse(plan.departure_time);
                if (Number.isFinite(durationMs) && durationMs > 0) {
                    const mins = Math.round(durationMs / 60000);
                    setText('duration', `${mins} min`);
                }
            }
            const waypointList = document.getElementById('waypointList');
            if (waypointList) {
                waypointList.innerHTML = plan.waypoints.map((wp, index) => {
                    const label = index === 0
                        ? 'Waypoint 1 (Start)'
                        : index === plan.waypoints.length - 1
                            ? `Waypoint ${index + 1} (End)`
                            : `Waypoint ${index + 1}`;
                    const altitude = Number.isFinite(wp.altitude_m) ? wp.altitude_m.toFixed(0) : '--';
                    return `
                        <div class="list-item">
                            <span class="status-dot online"></span>
                            <div class="list-item-content">
                                <div class="list-item-title">${label}</div>
                                <div class="list-item-subtitle">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} @ ${altitude}m</div>
                            </div>
                            <span class="status-badge online">Planned</span>
                        </div>
                    `;
                }).join('');
            }
        }

        const conformanceEntry = conformanceMap.get(mission.aircraft_id);
        const conformanceStatus = conformanceEntry?.status || 'unknown';
        const conformanceLabel = conformanceStatus === 'conforming'
            ? 'Conforming'
            : conformanceStatus === 'nonconforming'
                ? 'Nonconforming'
                : 'Unknown';
        const conformanceEl = document.getElementById('conformanceStatus');
        if (conformanceEl) {
            conformanceEl.textContent = conformanceLabel;
            conformanceEl.className = `detail-value status-badge ${getConformanceClass(conformanceStatus)}`;
        }
        setText('conformanceCode', conformanceEntry?.record?.conformance_state_code || '--');
        setText('conformanceDescription', conformanceEntry?.record?.description || '--');
        setText('conformanceUpdated', formatDate(conformanceEntry?.last_checked));

        const abortBtn = document.getElementById('abortMission');
        if (abortBtn) {
            abortBtn.disabled = !mission.aircraft_id;
            abortBtn.addEventListener('click', async () => {
                if (!mission.aircraft_id) return;
                const confirmAbort = confirm(`Abort mission and hold ${mission.aircraft_id}?`);
                if (!confirmAbort) return;
                try {
                    await API.holdDrone(mission.aircraft_id, 999);
                    alert(`Hold command sent to ${mission.aircraft_id}`);
                } catch (error) {
                    alert(`Failed to abort mission: ${error.message}`);
                }
            });
        }

        const approveBtn = document.getElementById('approveMission');
        if (approveBtn) {
            approveBtn.disabled = true;
            approveBtn.title = 'Approval handled in Flight Blender';
        }
    }

    document.addEventListener('DOMContentLoaded', loadMission);
})();
