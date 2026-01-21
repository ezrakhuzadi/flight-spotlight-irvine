/**
 * ATC Camera Controls
 * Shared UI widget that adds simple heading/tilt/zoom controls to any Cesium.Viewer.
 */

(function () {
    'use strict';

    const TWO_PI = Math.PI * 2;

    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function normalizeHeading(rad) {
        let value = rad % TWO_PI;
        if (value < 0) value += TWO_PI;
        return value;
    }

    function shortestHeadingDelta(from, to) {
        const a = normalizeHeading(from);
        const b = normalizeHeading(to);
        let delta = b - a;
        if (delta > Math.PI) delta -= TWO_PI;
        if (delta < -Math.PI) delta += TWO_PI;
        return delta;
    }

    function ensurePositionedContainer(container) {
        if (!container || typeof window === 'undefined') return;
        const style = window.getComputedStyle(container);
        if (style && style.position === 'static') {
            container.style.position = 'relative';
        }
    }

    function applyZoom(camera, direction, amount) {
        if (!camera) return;
        if (direction === 'in') {
            if (typeof camera.zoomIn === 'function') {
                camera.zoomIn(amount);
                return;
            }
            if (typeof camera.moveForward === 'function') {
                camera.moveForward(amount);
            }
            return;
        }
        if (typeof camera.zoomOut === 'function') {
            camera.zoomOut(amount);
            return;
        }
        if (typeof camera.moveBackward === 'function') {
            camera.moveBackward(amount);
        }
    }

    function applyPitchDelta(camera, deltaRad) {
        if (!camera || !Number.isFinite(deltaRad) || deltaRad === 0) return;
        if (deltaRad > 0 && typeof camera.rotateUp === 'function') {
            camera.rotateUp(deltaRad);
            return;
        }
        if (deltaRad < 0 && typeof camera.rotateDown === 'function') {
            camera.rotateDown(-deltaRad);
        }
    }

    function applyHeadingDelta(camera, deltaRad) {
        if (!camera || !Number.isFinite(deltaRad) || deltaRad === 0) return;
        if (deltaRad > 0 && typeof camera.rotateRight === 'function') {
            camera.rotateRight(deltaRad);
            return;
        }
        if (deltaRad < 0 && typeof camera.rotateLeft === 'function') {
            camera.rotateLeft(-deltaRad);
        }
    }

    function attach(viewer, options = {}) {
        if (!viewer || !viewer.container) return null;

        const container = viewer.container;
        const existing = container.querySelector('[data-atc-camera-controls="1"]');
        if (existing) return existing;

        ensurePositionedContainer(container);

        const config = {
            headingStepRad: Number.isFinite(options.headingStepRad) ? options.headingStepRad : toRad(10),
            pitchStepRad: Number.isFinite(options.pitchStepRad) ? options.pitchStepRad : toRad(6),
            zoomStepM: Number.isFinite(options.zoomStepM) ? options.zoomStepM : 120,
            defaultHeadingRad: Number.isFinite(options.defaultHeadingRad) ? options.defaultHeadingRad : 0,
            defaultPitchRad: Number.isFinite(options.defaultPitchRad) ? options.defaultPitchRad : toRad(-45)
        };

        const root = document.createElement('div');
        root.className = 'atc-camera-controls';
        root.dataset.atcCameraControls = '1';
        root.innerHTML = `
            <div class="atc-camera-controls__panel" role="group" aria-label="Camera controls">
                <div class="atc-camera-controls__header">
                    <div class="atc-camera-controls__title">Camera</div>
                    <button type="button" class="atc-camera-controls__toggle" data-action="toggle" aria-expanded="true" title="Collapse controls">—</button>
                </div>

                <div class="atc-camera-controls__body">
                    <div class="atc-camera-controls__row atc-camera-controls__row--presets" role="group" aria-label="Cardinal views">
                        <button type="button" class="atc-camera-controls__btn" data-action="heading" data-heading-deg="0" title="North">N</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="heading" data-heading-deg="90" title="East">E</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="heading" data-heading-deg="180" title="South">S</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="heading" data-heading-deg="270" title="West">W</button>
                    </div>

                    <div class="atc-camera-controls__grid" role="group" aria-label="Rotate and tilt">
                        <div></div>
                        <button type="button" class="atc-camera-controls__btn" data-action="tilt-up" title="Tilt up">▲</button>
                        <div></div>

                        <button type="button" class="atc-camera-controls__btn" data-action="rotate-left" title="Rotate left">◀</button>
                        <button type="button" class="atc-camera-controls__btn atc-camera-controls__btn--primary" data-action="reset" title="Reset view">0</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="rotate-right" title="Rotate right">▶</button>

                        <div></div>
                        <button type="button" class="atc-camera-controls__btn" data-action="tilt-down" title="Tilt down">▼</button>
                        <div></div>
                    </div>

                    <div class="atc-camera-controls__row atc-camera-controls__row--zoom" role="group" aria-label="Zoom">
                        <button type="button" class="atc-camera-controls__btn" data-action="zoom-in" title="Zoom in">+</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="zoom-out" title="Zoom out">−</button>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(root);

        function toggleCollapsed() {
            const panel = root.querySelector('.atc-camera-controls__panel');
            const body = root.querySelector('.atc-camera-controls__body');
            const toggle = root.querySelector('[data-action="toggle"]');
            if (!panel || !body || !toggle) return;

            const isCollapsed = panel.classList.toggle('atc-camera-controls__panel--collapsed');
            body.style.display = isCollapsed ? 'none' : '';
            toggle.textContent = isCollapsed ? '+' : '—';
            toggle.setAttribute('aria-expanded', String(!isCollapsed));
            toggle.title = isCollapsed ? 'Expand controls' : 'Collapse controls';
        }

        root.addEventListener('click', (event) => {
            const target = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
            if (!target) return;

            const action = target.getAttribute('data-action');
            const camera = viewer.camera;
            if (!camera) return;

            switch (action) {
                case 'toggle':
                    toggleCollapsed();
                    break;
                case 'rotate-left':
                    applyHeadingDelta(camera, -config.headingStepRad);
                    break;
                case 'rotate-right':
                    applyHeadingDelta(camera, config.headingStepRad);
                    break;
                case 'tilt-up':
                    applyPitchDelta(camera, config.pitchStepRad);
                    break;
                case 'tilt-down':
                    applyPitchDelta(camera, -config.pitchStepRad);
                    break;
                case 'zoom-in':
                    applyZoom(camera, 'in', config.zoomStepM);
                    break;
                case 'zoom-out':
                    applyZoom(camera, 'out', config.zoomStepM);
                    break;
                case 'heading': {
                    const deg = Number(target.getAttribute('data-heading-deg'));
                    if (!Number.isFinite(deg)) return;
                    const desired = toRad(deg);
                    const delta = shortestHeadingDelta(camera.heading, desired);
                    applyHeadingDelta(camera, delta);
                    break;
                }
                case 'reset': {
                    const headingDelta = shortestHeadingDelta(camera.heading, config.defaultHeadingRad);
                    applyHeadingDelta(camera, headingDelta);

                    const pitchNow = camera.pitch;
                    if (Number.isFinite(pitchNow)) {
                        const clampedDefaultPitch = clamp(config.defaultPitchRad, toRad(-89), toRad(25));
                        const pitchDelta = clampedDefaultPitch - pitchNow;
                        applyPitchDelta(camera, pitchDelta);
                    }
                    break;
                }
                default:
                    break;
            }
        });

        return root;
    }

    window.ATCCameraControls = Object.assign(window.ATCCameraControls || {}, { attach });
})();
