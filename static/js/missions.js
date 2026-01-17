/**
 * Missions Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 5000;

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

    const PLAN_STATUS_LABELS = {
        pending: 'Pending',
        approved: 'Approved',
        active: 'Active',
        completed: 'Completed',
        rejected: 'Rejected',
        cancelled: 'Cancelled'
    };

    /**
     * Load and display missions from Flight Blender
     */
    async function loadMissions() {
        try {
            const [declarations, conformance, plans] = await Promise.all([
                API.getFlightDeclarations(),
                API.getConformance().catch(() => []),
                API.getFlightPlans().catch(() => [])
            ]);
            const conformanceMap = new Map((conformance || []).map(entry => [entry.drone_id, entry]));
            const planMap = buildPlanMap(plans || []);

            const activeStates = new Set([2, 3, 4]);
            const completedStates = new Set([5, 6, 7, 8]);

            const active = declarations.filter(decl => activeStates.has(decl.state));
            const completed = declarations.filter(decl => completedStates.has(decl.state));
            const pending = declarations.filter(decl => !activeStates.has(decl.state) && !completedStates.has(decl.state));

            renderMissionSection('activeMissions', active, 'active', conformanceMap, planMap);
            renderMissionSection('pendingMissions', pending, 'pending', conformanceMap, planMap);
            renderMissionSection('completedMissions', completed, 'completed', conformanceMap, planMap);
        } catch (error) {
            console.error('[Missions] Load failed:', error);
        }
    }

    function renderMissionSection(containerId, missions, type, conformanceMap, planMap) {
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
            const missionId = mission.id || mission.pk || '';
            const missionName = mission.originating_party || (missionId ? `Mission ${missionId.slice(0, 8)}` : 'Mission');
            const stateLabel = STATE_LABELS[mission.state] || 'Unknown';
            const timeRange = `${formatDate(mission.start_datetime)} - ${formatDate(mission.end_datetime)}`;
            const compliance = getComplianceSummary(mission);
            const complianceLine = compliance
                ? `<div class="list-item-subtitle"><span class="status-badge ${compliance.className}">Compliance ${compliance.label}</span></div>`
                : '';
            const conformance = getConformanceSummary(mission, conformanceMap);
            const conformanceLine = conformance
                ? `<div class="list-item-subtitle"><span class="status-badge ${conformance.className}">Conformance ${conformance.label}</span></div>`
                : '';
            const conformanceDetail = conformance?.detail
                ? `<div class="list-item-subtitle">${conformance.detail}</div>`
                : '';
            const plan = getPlanSummary(mission, planMap);
            const planLine = plan
                ? `<div class="list-item-subtitle"><span class="status-badge ${plan.className}">ATC Plan ${plan.label}</span></div>`
                : '';
            const detailsButton = missionId
                ? `<button class="btn btn-ghost btn-sm" onclick="window.location.href='/control/missions/${missionId}'">Details</button>`
                : '';
            return `
                <div class="list-item">
                    <span class="status-dot ${type === 'active' ? 'flying' : 'idle'}"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">${missionName}</div>
                        <div class="list-item-subtitle">Drone: ${mission.aircraft_id || 'Unassigned'}</div>
                        <div class="list-item-subtitle">State: ${stateLabel}</div>
                        <div class="list-item-subtitle">${timeRange}</div>
                        ${complianceLine}
                        ${conformanceLine}
                        ${conformanceDetail}
                        ${planLine}
                    </div>
                    <div class="list-item-actions">
                        ${detailsButton}
                        ${type === 'active' ? `
                            <button class="btn btn-ghost btn-sm" onclick="window.location.href='/control/map?track=${mission.aircraft_id || ''}'">
                                Track
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    function buildPlanMap(plans) {
        const map = new Map();
        plans.forEach((plan) => {
            if (!plan || !plan.drone_id) return;
            const existing = map.get(plan.drone_id);
            if (!existing) {
                map.set(plan.drone_id, plan);
                return;
            }
            const currentTime = Date.parse(plan.created_at || '') || 0;
            const existingTime = Date.parse(existing.created_at || '') || 0;
            if (currentTime >= existingTime) {
                map.set(plan.drone_id, plan);
            }
        });
        return map;
    }

    function getPlanSummary(mission, planMap) {
        if (!planMap || !mission?.aircraft_id) return null;
        const plan = planMap.get(mission.aircraft_id);
        if (!plan) return null;
        const status = String(plan.status || '').toLowerCase();
        const label = PLAN_STATUS_LABELS[status] || 'Unknown';
        return { label, className: getPlanClass(status) };
    }

    function getPlanClass(status) {
        switch (status) {
            case 'active':
                return 'flying';
            case 'completed':
                return 'pass';
            case 'approved':
                return 'pending';
            case 'rejected':
            case 'cancelled':
                return 'fail';
            case 'pending':
            default:
                return 'warn';
        }
    }

    function getComplianceSummary(mission) {
        const geo = mission.flight_declaration_geojson || mission.flight_declaration_raw_geojson;
        if (!geo) return null;
        let data = geo;
        if (typeof geo === 'string') {
            try {
                data = JSON.parse(geo);
            } catch (error) {
                return null;
            }
        }
        const compliance = data?.features?.[0]?.properties?.compliance;
        if (!compliance) return null;
        const status = compliance.overall_status || 'pending';
        const className = ['pass', 'warn', 'fail', 'pending'].includes(status) ? status : 'pending';
        const label = status === 'warn' ? 'Warn' : status.charAt(0).toUpperCase() + status.slice(1);
        return { className, label };
    }

    function getConformanceSummary(mission, conformanceMap) {
        if (!conformanceMap || !mission?.aircraft_id) return null;
        const entry = conformanceMap.get(mission.aircraft_id);
        if (!entry) {
            return { className: 'warn', label: 'Unknown' };
        }
        const status = entry.status || 'unknown';
        const className = getConformanceClass(status);
        const label = status === 'nonconforming' ? 'Nonconforming' : status === 'conforming' ? 'Conforming' : 'Unknown';
        const record = entry.record;
        const detail = status === 'nonconforming' && record
            ? `${record.conformance_state_code || 'NC'}: ${record.description || 'Conformance issue'}`
            : null;
        return { className, label, detail };
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
        window.location.href = '/control/missions/plan';
    }

    function formatDate(dateString) {
        if (!dateString) return 'Unknown';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return dateString;
        return date.toLocaleString();
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
