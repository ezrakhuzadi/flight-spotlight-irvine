// Custom requiresAuth middleware for dev mode
// In dev mode, always allows access since user is mocked

const { requiresAuth: oidcRequiresAuth } = require('express-openid-connect');

function requiresAuth() {
    const authStrategy = process.env.AUTH_STRATEGY || 'flightpassport';
    console.log(`[DEBUG] requiresAuth called with strategy: ${authStrategy}`);

    if (authStrategy === 'dev_bypass') {
        console.log('[DEBUG] Using dev_bypass middleware (pass-through)');
        // In dev mode, just pass through - user is already mocked
        return (req, res, next) => next();
    }

    console.log('[DEBUG] Using OIDC middleware');
    // In production, use the real OIDC requiresAuth
    return oidcRequiresAuth();
}

module.exports = { requiresAuth };
