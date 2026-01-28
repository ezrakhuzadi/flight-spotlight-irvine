/**
 * Cesium ion helpers.
 *
 * Supports Cesium ion Google 2D Maps imagery assets even when the vendored Cesium build
 * doesn't recognize `externalType: "GOOGLE_2D_MAPS"` (by falling back to a UrlTemplateImageryProvider).
 */

(function (root) {
    'use strict';

    const ION_API_BASE = 'https://api.cesium.com/v1/assets';

    function safeString(value) {
        return typeof value === 'string' ? value : '';
    }

    function safeNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function joinUrl(base, path) {
        if (!base) return path;
        if (base.endsWith('/') && path.startsWith('/')) return base.slice(0, -1) + path;
        if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
        return base + path;
    }

    function buildCreditHtml(attributions) {
        if (!Array.isArray(attributions)) return '';
        return attributions
            .map((entry) => safeString(entry && entry.html).trim())
            .filter(Boolean)
            .join(' ');
    }

    async function fetchIonEndpoint(assetId, ionToken) {
        const normalizedId = safeNumber(assetId);
        const token = safeString(ionToken).trim();
        if (!normalizedId) {
            throw new Error('Invalid Ion asset id');
        }
        if (!token) {
            throw new Error('CESIUM_ION_TOKEN not set');
        }

        const endpointUrl = `${ION_API_BASE}/${normalizedId}/endpoint?access_token=${encodeURIComponent(token)}`;
        const response = await fetch(endpointUrl, { credentials: 'omit' });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Ion endpoint fetch failed (${response.status}): ${text || response.statusText}`);
        }
        return response.json();
    }

    function createGoogle2DMapsProvider(endpoint) {
        const options = endpoint && endpoint.options ? endpoint.options : {};
        const baseUrl = safeString(options.url).trim();
        const session = safeString(options.session).trim();
        const key = safeString(options.key).trim();
        if (!baseUrl || !session || !key) {
            throw new Error('Ion Google 2D endpoint missing url/session/key');
        }

        const tileWidth = safeNumber(options.tileWidth) ?? 256;
        const tileHeight = safeNumber(options.tileHeight) ?? 256;
        const creditHtml = buildCreditHtml(endpoint && endpoint.attributions);

        const tileTemplate = joinUrl(baseUrl.replace(/\/$/, ''), `/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(key)}`);

        const providerOptions = {
            url: tileTemplate,
            tileWidth,
            tileHeight,
            tilingScheme: new Cesium.WebMercatorTilingScheme()
        };

        if (creditHtml) {
            providerOptions.credit = new Cesium.Credit(creditHtml);
        }

        return new Cesium.UrlTemplateImageryProvider(providerOptions);
    }

    async function createIonImageryProvider(assetId, ionToken) {
        const normalizedId = safeNumber(assetId);
        if (!normalizedId) {
            throw new Error('Invalid Ion asset id');
        }

        // If the current Cesium build supports the asset via IonImageryProvider, prefer that.
        // Otherwise fall back to a UrlTemplateImageryProvider for Google 2D Maps.
        if (Cesium && Cesium.IonImageryProvider && typeof Cesium.IonImageryProvider.fromAssetId === 'function') {
            try {
                return await Cesium.IonImageryProvider.fromAssetId(normalizedId);
            } catch (error) {
                const message = safeString(error && error.message);
                if (!message.includes('GOOGLE_2D_MAPS')) {
                    throw error;
                }
                const endpoint = await fetchIonEndpoint(normalizedId, ionToken);
                if (endpoint && endpoint.externalType === 'GOOGLE_2D_MAPS') {
                    return createGoogle2DMapsProvider(endpoint);
                }
                throw error;
            }
        }

        const endpoint = await fetchIonEndpoint(normalizedId, ionToken);
        if (endpoint && endpoint.externalType === 'GOOGLE_2D_MAPS') {
            return createGoogle2DMapsProvider(endpoint);
        }
        throw new Error(`Unsupported imagery type: ${safeString(endpoint && endpoint.externalType) || 'unknown'}`);
    }

    async function addIonImageryLayer(viewer, assetId, ionToken, options = {}) {
        if (!viewer || !viewer.imageryLayers) {
            throw new Error('Cesium viewer not initialized');
        }
        const provider = await createIonImageryProvider(assetId, ionToken);
        provider.errorEvent?.addEventListener?.((error) => {
            console.warn('[CesiumIon] Imagery error:', error);
        });
        const layer = viewer.imageryLayers.addImageryProvider(provider);
        viewer.imageryLayers.raiseToTop(layer);

        if (options && options.alpha != null) {
            layer.alpha = Number(options.alpha);
        }
        if (options && options.show != null) {
            layer.show = Boolean(options.show);
        }
        return layer;
    }

    root.ATCCesiumIon = {
        fetchIonEndpoint,
        createIonImageryProvider,
        addIonImageryLayer
    };
})(typeof window !== 'undefined' ? window : globalThis);

