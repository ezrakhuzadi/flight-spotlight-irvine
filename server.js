(async function () {
  "use strict";
  /*jshint node:true*/

  const express = require("express");
  const session = require("express-session");
  const crypto = require("crypto");
  const path = require("path");
  const fs = require("fs");
  const bcrypt = require("bcryptjs");
  const axios = require("axios");
  const { socketConnection } = require("./util/io");
  const { initUserStore } = require("./util/user-store");
  const { requireAuth, requireRole } = require("./util/auth");
  require("dotenv").config();

  const controlRouter = require("./routes/control");
  const FileStore = require("session-file-store")(session);

  const BLENDER_URL = process.env.BLENDER_URL || process.env.BLENDER_BASE_URL || "http://localhost:8000";
  const ATC_URL = process.env.ATC_SERVER_URL || "http://host.docker.internal:3000";
  const ATC_PROXY_BASE = process.env.ATC_PROXY_BASE || "/api/atc";
  const BLENDER_AUDIENCE = process.env.PASSPORT_AUDIENCE || "testflight.flightblender.com";
  const PASSWORD_ALGO = "bcrypt";
  const PASSWORD_ROUNDS = Number(process.env.PASSWORD_ROUNDS || 10);

  const COMPLIANCE_LIMITS = {
    maxWindMps: 12,
    maxGustMps: 15,
    maxPrecipMm: 2,
    windWarnRatio: 0.8,
    batteryWarnMarginMin: 5,
    populationBvlosMax: 1500,
    populationWarn: 2000,
    populationAbsoluteMax: 4000,
    defaultClearanceM: 60
  };

  const HAZARDS = [
    { id: "tower-1", name: "Campus Tower", lat: 33.6459, lon: -117.8422, radiusM: 80 },
    { id: "power-1", name: "Power Corridor", lat: 33.6835, lon: -117.8302, radiusM: 120 },
    { id: "hospital-1", name: "Helipad Zone", lat: 33.6431, lon: -117.8455, radiusM: 150 },
    { id: "stadium-1", name: "Stadium Complex", lat: 33.6505, lon: -117.8372, radiusM: 180 }
  ];

  // Hash password helper
  function hashPassword(password) {
    return bcrypt.hashSync(password, PASSWORD_ROUNDS);
  }

  function hashLegacyPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
  }

  function verifyPassword(user, password) {
    if (!user || !password) return false;
    const algo = user.passwordAlgo || "sha256";
    if (algo === PASSWORD_ALGO) {
      return bcrypt.compareSync(password, user.passwordHash);
    }
    const legacyHash = hashLegacyPassword(password);
    if (legacyHash !== user.passwordHash) {
      return false;
    }
    const upgraded = hashPassword(password);
    userStore.updatePassword(user.id, upgraded, PASSWORD_ALGO);
    user.passwordHash = upgraded;
    user.passwordAlgo = PASSWORD_ALGO;
    return true;
  }

  function base64UrlEncode(value) {
    return Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  function createDevJwt(scopes) {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: "dummy",
      aud: BLENDER_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 120,
      scope: scopes.join(" ")
    };
    const signature = Buffer.from("signature")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `${base64UrlEncode(header)}.${base64UrlEncode(payload)}.${signature}`;
  }

  function buildDemoRidPayload(center, subscriptionId) {
    const testId = typeof subscriptionId === "string" && subscriptionId ? subscriptionId : crypto.randomUUID();
    const injectionId = crypto.randomUUID();
    const baseLat = Number.isFinite(center?.lat) ? center.lat : 33.6846;
    const baseLon = Number.isFinite(center?.lon) ? center.lon : -117.8265;
    const now = Date.now();
    const offsets = [
      [0, 0],
      [0.0015, 0.001],
      [0.003, 0.0018],
      [0.0045, 0.0022],
      [0.006, 0.0028]
    ];

    const telemetry = offsets.map((offset, index) => ({
      timestamp: new Date(now + index * 1000).toISOString(),
      timestamp_accuracy: 0,
      operational_status: "Airborne",
      position: {
        lat: baseLat + offset[0],
        lng: baseLon + offset[1],
        alt: 120,
        accuracy_h: "HAUnknown",
        accuracy_v: "VAUnknown",
        extrapolated: false,
        pressure_altitude: 0
      },
      height: { distance: 50, reference: "TakeoffLocation" },
      track: 90,
      speed: 8,
      speed_accuracy: "SAUnknown",
      vertical_speed: 0
    }));

    const payload = {
      requested_flights: [
        {
          injection_id: injectionId,
          aircraft_type: "UAS",
          telemetry,
          details_responses: [
            {
              effective_after: new Date(now).toISOString(),
              details: {
                id: injectionId,
                operator_id: "demo-operator",
                operator_location: { lat: baseLat, lng: baseLon },
                operation_description: "Demo Remote ID traffic",
                serial_number: injectionId,
                registration_number: `DEMO-${injectionId.slice(0, 8)}`
              }
            }
          ]
        }
      ]
    };

    return { testId, injectionId, payload };
  }

  const userStore = initUserStore();
  userStore.ensureDefaults(hashPassword, PASSWORD_ALGO);

  let app = express();

  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.set("view engine", "ejs");
  app.use(express.static(__dirname + "/views"));
  app.use("/assets", express.static("static"));

  // Session middleware
  const sessionPath = process.env.SESSION_STORE_PATH || path.join(__dirname, "data", "sessions");
  fs.mkdirSync(sessionPath, { recursive: true });
  app.use(session({
    store: new FileStore({
      path: sessionPath,
      logFn: () => {}
    }),
    secret: process.env.SESSION_SECRET || "atc-drone-dev-secret-change-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // Make user available to all views
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.atcApiBase = ATC_PROXY_BASE;
    next();
  });

  // ========================================
  // Auth Routes
  // ========================================

  // Login page
  app.get('/login', (req, res) => {
    if (req.session.user) {
      return res.redirect('/control');
    }
    res.render('login', { error: null });
  });

  // Login form submission
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = userStore.getUserById(username);
    if (user && verifyPassword(user, password)) {
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      };
      userStore.touchLogin(user.id);
      console.log(`[AUTH] User logged in: ${user.id}`);
      return res.redirect('/control');
    }

    res.render('login', { error: 'Invalid username or password' });
  });

  // Guest login (one-click)
  app.post('/login/guest', (req, res) => {
    const guest = userStore.getUserById('guest');
    req.session.user = {
      id: guest.id,
      name: guest.name,
      email: guest.email,
      role: guest.role,
      createdAt: guest.createdAt
    };
    userStore.touchLogin(guest.id);
    console.log('[AUTH] Guest user logged in');
    res.redirect('/control');
  });

  // Signup page
  app.get('/signup', (req, res) => {
    if (req.session.user) {
      return res.redirect('/control');
    }
    res.render('signup', { error: null, success: null });
  });

  // Signup form submission
  app.post('/signup', (req, res) => {
    const { username, email, password, confirmPassword, name } = req.body;

    // Validation
    if (!username || !email || !password || !name) {
      return res.render('signup', {
        error: 'All fields are required',
        success: null
      });
    }

    if (password.length < 6) {
      return res.render('signup', {
        error: 'Password must be at least 6 characters',
        success: null
      });
    }

    if (password !== confirmPassword) {
      return res.render('signup', {
        error: 'Passwords do not match',
        success: null
      });
    }

    if (userStore.getUserById(username)) {
      return res.render('signup', {
        error: 'Username already exists',
        success: null
      });
    }

    // Check email uniqueness
    if (userStore.getUserByEmail(email)) {
      return res.render('signup', {
        error: 'Email already registered',
        success: null
      });
    }

    // Create user
    const newUser = userStore.createUser({
      id: username,
      name: name,
      email: email,
      passwordHash: hashPassword(password),
      passwordAlgo: PASSWORD_ALGO,
      role: 'operator',
    });
    console.log(`[AUTH] New user registered: ${username}`);

    // Auto-login after signup
    req.session.user = {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      createdAt: newUser.createdAt
    };
    res.redirect('/control');
  });

  // Logout  
  app.get('/logout', (req, res) => {
    const userId = req.session.user?.id;
    req.session.destroy((err) => {
      if (err) console.error('[AUTH] Logout error:', err);
      console.log(`[AUTH] User logged out: ${userId}`);
      res.redirect('/login');
    });
  });

  // ========================================
  // Profile update routes
  // ========================================
  app.post('/account/update-profile', requireAuth, (req, res) => {
    const { name, email } = req.body;
    const userId = req.session.user.id;
    const user = userStore.getUserById(userId);

    if (!user) {
      return res.redirect('/control/settings?error=user_not_found');
    }

    const existingEmailUser = userStore.getUserByEmail(email);
    if (existingEmailUser && existingEmailUser.id !== userId) {
      return res.redirect('/control/settings?error=email_taken');
    }

    const updatedUser = userStore.updateProfile(userId, {
      name: name || user.name,
      email: email || user.email
    });

    req.session.user.name = updatedUser.name;
    req.session.user.email = updatedUser.email;
    console.log(`[AUTH] Profile updated: ${userId}`);
    return res.redirect('/control/settings?updated=profile');
  });

  app.post('/account/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    const userId = req.session.user.id;
    const user = userStore.getUserById(userId);

    if (!user) {
      return res.redirect('/control/settings?error=user_not_found');
    }

    if (!verifyPassword(user, currentPassword)) {
      return res.redirect('/control/settings?error=wrong_password');
    }

    if (newPassword.length < 6) {
      return res.redirect('/control/settings?error=password_short');
    }

    if (newPassword !== confirmNewPassword) {
      return res.redirect('/control/settings?error=password_mismatch');
    }

    userStore.updatePassword(userId, hashPassword(newPassword), PASSWORD_ALGO);
    console.log(`[AUTH] Password changed: ${userId}`);
    res.redirect('/control/settings?updated=password');
  });

  app.post('/account/delete', requireAuth, (req, res) => {
    const userId = req.session.user.id;

    if (userId === 'guest' || userId === 'admin') {
      return res.redirect('/control/settings?error=cannot_delete');
    }

    userStore.deleteUser(userId);
    console.log(`[AUTH] Account deleted: ${userId}`);

    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // ========================================
  // Flight Blender proxy (RID/DSS)
  // ========================================
  function parseBlenderPayload(payload) {
    if (typeof payload !== "string") {
      return payload;
    }
    try {
      return JSON.parse(payload);
    } catch (e) {
      return payload;
    }
  }

  app.put("/api/rid/subscription", requireAuth, async (req, res) => {
    const view = req.query.view;
    if (!view) {
      return res.status(400).json({ message: "Missing view bbox" });
    }

    try {
      const token = createDevJwt(["flightblender.read", "flightblender.write"]);
      const response = await axios.put(
        `${BLENDER_URL}/rid/create_dss_subscription`,
        null,
        {
          params: { view },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[RID Proxy] Subscription error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.get("/api/rid/data/:subscriptionId", requireAuth, async (req, res) => {
    try {
      const token = createDevJwt(["flightblender.read"]);
      const response = await axios.get(
        `${BLENDER_URL}/rid/get_rid_data/${req.params.subscriptionId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[RID Proxy] Data error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.post("/api/rid/demo", requireRole("authority"), async (req, res) => {
    try {
      const { testId, injectionId, payload } = buildDemoRidPayload(req.body?.center, req.body?.subscription_id);
      const token = createDevJwt(["rid.inject_test_data"]);
      const response = await axios.put(
        `${BLENDER_URL}/rid/tests/${testId}`,
        payload,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json({
        test_id: testId,
        injection_id: injectionId,
        response: parseBlenderPayload(response.data)
      });
    } catch (error) {
      console.error("[RID Proxy] Demo injection error:", error.message);
      res.status(502).json({ message: "Failed to inject demo RID traffic" });
    }
  });

  app.get("/api/compliance/weather", requireAuth, async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ message: "lat and lon query params are required" });
    }

    try {
      const response = await axios.get("https://api.open-meteo.com/v1/forecast", {
        params: {
          latitude: lat,
          longitude: lon,
          current: "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,weather_code",
          windspeed_unit: "ms",
          timezone: "UTC"
        },
        timeout: 8000
      });
      res.status(200).json(response.data);
    } catch (error) {
      console.error("[Compliance] Weather error:", error.message);
      res.status(502).json({ message: "Failed to reach weather provider" });
    }
  });

  // ========================================
  // ATC-Drone proxy (same-origin for frontend)
  // ========================================
  function requiresAuthorityForAtc(req) {
    const method = req.method.toUpperCase();
    if (method === "GET") return false;
    const requestPath = req.path.startsWith(ATC_PROXY_BASE)
      ? req.path.slice(ATC_PROXY_BASE.length)
      : req.path;

    if (requestPath.startsWith("/v1/geofences/check")) return false;
    if (requestPath.startsWith("/v1/geofences/check-route")) return false;
    if (requestPath.startsWith("/v1/geofences") && ["POST", "PUT", "DELETE"].includes(method)) {
      return true;
    }
    if (requestPath.startsWith("/v1/admin")) return true;
    return false;
  }

  app.all(`${ATC_PROXY_BASE}/*`, requireAuth, async (req, res) => {
    if (requiresAuthorityForAtc(req) && req.session.user?.role !== "authority") {
      return res.status(403).json({ message: "insufficient_role" });
    }
    const targetPath = req.originalUrl.replace(ATC_PROXY_BASE, "");
    const url = `${ATC_URL}${targetPath}`;
    const method = req.method.toUpperCase();
    const data = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? req.body : undefined;

    try {
      const response = await axios({
        method,
        url,
        data,
        timeout: 10000,
        validateStatus: () => true,
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (typeof response.data === "object") {
        return res.status(response.status).json(response.data);
      }
      return res.status(response.status).send(response.data);
    } catch (error) {
      console.error("[ATC Proxy] Request failed:", error.message);
      return res.status(502).json({ message: "Failed to reach ATC server" });
    }
  });

  // ========================================
  // Flight Declaration proxy (Mission Planning)
  // ========================================

  function extractCompliance(payload) {
    if (!payload) return null;
    const geo = extractGeoJson(payload);
    if (!geo) return null;
    const feature = geo?.features?.[0];
    return feature?.properties?.compliance || null;
  }

  function extractGeoJson(payload) {
    if (!payload) return null;
    let geo = payload.flight_declaration_geo_json || payload.flight_declaration_geojson;
    if (!geo) return null;
    if (typeof geo === "string") {
      try {
        geo = JSON.parse(geo);
        payload.flight_declaration_geo_json = geo;
      } catch (error) {
        return null;
      }
    }
    return geo;
  }

  function extractRoutePoints(geo) {
    if (!geo || !Array.isArray(geo.features)) return [];
    const points = [];
    geo.features.forEach((feature) => {
      const geometry = feature?.geometry;
      if (!geometry) return;
      const { type, coordinates } = geometry;
      if (!coordinates) return;
      if (type === "Point") {
        points.push({ lon: coordinates[0], lat: coordinates[1] });
      } else if (type === "LineString") {
        coordinates.forEach((coord) => points.push({ lon: coord[0], lat: coord[1] }));
      } else if (type === "Polygon") {
        (coordinates[0] || []).forEach((coord) => points.push({ lon: coord[0], lat: coord[1] }));
      } else if (type === "MultiLineString") {
        (coordinates[0] || []).forEach((coord) => points.push({ lon: coord[0], lat: coord[1] }));
      } else if (type === "MultiPolygon") {
        const ring = coordinates?.[0]?.[0] || [];
        ring.forEach((coord) => points.push({ lon: coord[0], lat: coord[1] }));
      }
    });
    return points;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dphi = (lat2 - lat1) * Math.PI / 180;
    const dlambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dphi / 2) ** 2
      + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function computeRouteDistance(points) {
    if (!Array.isArray(points) || points.length < 2) return 0;
    let distance = 0;
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const next = points[i];
      distance += haversineDistance(prev.lat, prev.lon, next.lat, next.lon);
    }
    return distance;
  }

  function distanceToRouteMeters(hazard, points) {
    if (!Array.isArray(points) || points.length === 0) return Infinity;

    const refLat = hazard.lat * Math.PI / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos(refLat);

    const toXY = (point) => ({
      x: (point.lon - hazard.lon) * metersPerDegLon,
      y: (point.lat - hazard.lat) * metersPerDegLat
    });

    let min = Infinity;
    points.forEach((point) => {
      const pos = toXY(point);
      const dist = Math.hypot(pos.x, pos.y);
      if (dist < min) min = dist;
    });

    for (let i = 1; i < points.length; i += 1) {
      const a = toXY(points[i - 1]);
      const b = toXY(points[i]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = -(a.x * dx + a.y * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + t * dx;
      const cy = a.y + t * dy;
      const dist = Math.hypot(cx, cy);
      if (dist < min) min = dist;
    }

    return min;
  }

  function summarizeStatus(checks) {
    let hasWarn = false;
    let hasPending = false;
    let hasFail = false;

    Object.values(checks).forEach((check) => {
      if (check.status === "fail") hasFail = true;
      if (check.status === "pending") hasPending = true;
      if (check.status === "warn") hasWarn = true;
    });

    if (hasFail) return "fail";
    if (hasPending) return "pending";
    if (hasWarn) return "warn";
    return "pass";
  }

  function evaluateWeatherCompliance(compliance) {
    const weather = compliance?.checks?.weather || {};
    const wind = toNumber(weather.windMps);
    const gust = toNumber(weather.gustMps);
    const precip = toNumber(weather.precipMm);
    const maxWind = toNumber(weather.maxWindMps) ?? COMPLIANCE_LIMITS.maxWindMps;
    const maxGust = toNumber(weather.maxGustMps) ?? COMPLIANCE_LIMITS.maxGustMps;
    const maxPrecip = toNumber(weather.maxPrecipMm) ?? COMPLIANCE_LIMITS.maxPrecipMm;

    if (wind === null || gust === null || precip === null) {
      return { status: "pending", message: "Weather values missing" };
    }

    let status = "pass";
    if (wind > maxWind || gust > maxGust || precip > maxPrecip) {
      status = "fail";
    } else if (
      wind > maxWind * COMPLIANCE_LIMITS.windWarnRatio
      || gust > maxGust * COMPLIANCE_LIMITS.windWarnRatio
      || precip > maxPrecip * COMPLIANCE_LIMITS.windWarnRatio
    ) {
      status = "warn";
    }

    return {
      status,
      windMps: wind,
      gustMps: gust,
      precipMm: precip,
      maxWindMps: maxWind,
      maxGustMps: maxGust,
      maxPrecipMm: maxPrecip
    };
  }

  function evaluateBatteryCompliance(compliance, route) {
    const battery = compliance?.checks?.battery || {};
    const capacity = toNumber(battery.capacityMin);
    const reserve = toNumber(battery.reserveMin);
    const cruiseSpeed = toNumber(battery.cruiseSpeedMps);

    if (!route || !route.hasRoute || capacity === null || reserve === null || cruiseSpeed === null || cruiseSpeed <= 0) {
      return { status: "pending", message: "Battery inputs missing" };
    }

    const estimatedMinutes = route.distanceM / cruiseSpeed / 60;
    const remaining = capacity - estimatedMinutes;
    let status = "pass";
    if (remaining < reserve) {
      status = "fail";
    } else if (remaining < reserve + COMPLIANCE_LIMITS.batteryWarnMarginMin) {
      status = "warn";
    }

    return {
      status,
      estimatedMinutes,
      capacityMin: capacity,
      reserveMin: reserve,
      remainingMin: remaining
    };
  }

  function evaluatePopulationCompliance(compliance, payload) {
    const population = compliance?.checks?.population || {};
    const density = toNumber(population.density);
    if (density === null) {
      return { status: "pending", message: "Population density missing" };
    }

    const type = Number(payload?.type_of_operation || 1);
    const isBvlos = type === 2;
    let status = "pass";
    if (density >= COMPLIANCE_LIMITS.populationAbsoluteMax) {
      status = "fail";
    } else if (isBvlos && density > COMPLIANCE_LIMITS.populationBvlosMax) {
      status = "fail";
    } else if (density >= COMPLIANCE_LIMITS.populationWarn) {
      status = "warn";
    }

    return { status, density };
  }

  function evaluateObstacleCompliance(compliance, points) {
    const obstacles = compliance?.checks?.obstacles || {};
    const clearance = toNumber(obstacles.clearanceM) ?? COMPLIANCE_LIMITS.defaultClearanceM;

    if (!points || points.length === 0) {
      return { status: "pending", message: "Route missing", clearanceM: clearance };
    }

    const conflicts = [];
    const warnings = [];
    const warnBuffer = clearance * 1.5;

    HAZARDS.forEach((hazard) => {
      const distance = distanceToRouteMeters(hazard, points);
      const conflictThreshold = hazard.radiusM + clearance;
      const warnThreshold = hazard.radiusM + warnBuffer;
      if (distance <= conflictThreshold) {
        conflicts.push({ id: hazard.id, name: hazard.name, distanceM: distance });
      } else if (distance <= warnThreshold) {
        warnings.push({ id: hazard.id, name: hazard.name, distanceM: distance });
      }
    });

    const status = conflicts.length ? "fail" : warnings.length ? "warn" : "pass";
    return {
      status,
      clearanceM: clearance,
      conflicts: conflicts.concat(warnings)
    };
  }

  function validateCompliance(compliance, payload) {
    if (!compliance || typeof compliance !== "object") {
      return { ok: false, message: "Compliance data missing" };
    }

    const overrideEnabled = !!compliance.override?.enabled;
    const overrideNotes = (compliance.override?.notes || "").trim();
    if (overrideEnabled && overrideNotes.length < 8) {
      return { ok: false, message: "Override notes required", blocking: ["override"] };
    }

    const geo = extractGeoJson(payload);
    const points = extractRoutePoints(geo);
    const distanceM = computeRouteDistance(points);
    const cruiseSpeed = toNumber(compliance?.checks?.battery?.cruiseSpeedMps) ?? 0;
    const estimatedMinutes = cruiseSpeed > 0 ? distanceM / cruiseSpeed / 60 : 0;
    const route = { distanceM, estimatedMinutes, hasRoute: points.length > 0 };

    const checks = {
      weather: evaluateWeatherCompliance(compliance),
      battery: evaluateBatteryCompliance(compliance, route),
      population: evaluatePopulationCompliance(compliance, payload),
      obstacles: evaluateObstacleCompliance(compliance, points)
    };

    compliance.route = route;
    compliance.checks = { ...compliance.checks, ...checks };
    compliance.overall_status = summarizeStatus(checks);

    const blocking = Object.entries(checks)
      .filter(([, check]) => check.status === "fail" || check.status === "pending")
      .map(([key]) => key);

    if (blocking.length && !overrideEnabled) {
      return {
        ok: false,
        message: "Compliance checks failed",
        blocking
      };
    }

    return { ok: true };
  }

  app.get("/api/blender/flight-declarations", requireAuth, async (req, res) => {
    try {
      const token = createDevJwt(["flightblender.read"]);
      const response = await axios.get(
        `${BLENDER_URL}/flight_declaration_ops/flight_declaration`,
        {
          params: req.query,
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[Blender Proxy] Flight declarations error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.get("/api/blender/flight-declarations/:id", requireAuth, async (req, res) => {
    try {
      const token = createDevJwt(["flightblender.read"]);
      const response = await axios.get(
        `${BLENDER_URL}/flight_declaration_ops/flight_declaration/${req.params.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[Blender Proxy] Flight declaration detail error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.post("/api/blender/flight-declarations", requireAuth, async (req, res) => {
    const compliance = extractCompliance(req.body);
    const complianceResult = validateCompliance(compliance, req.body);
    if (!complianceResult.ok) {
      return res.status(400).json({
        message: complianceResult.message,
        blocking_checks: complianceResult.blocking || []
      });
    }

    try {
      const token = createDevJwt(["flightblender.write"]);
      const response = await axios.post(
        `${BLENDER_URL}/flight_declaration_ops/set_flight_declaration`,
        req.body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[Blender Proxy] Flight declaration submit error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  // ========================================
  // Protected Routes
  // ========================================

  // Mission Control routes (require authentication)
  app.use("/control", requireAuth, controlRouter);

  // Redirect root to control
  app.get('/', (req, res) => {
    if (req.session.user) {
      res.redirect('/control');
    } else {
      res.redirect('/login');
    }
  });

  // SDK Documentation (public)
  app.get('/docs', (req, res) => {
    res.render('docs', { user: req.session.user || null });
  });

  // Constants
  let server = app.listen(process.env.PORT || 5000);

  socketConnection(server);

  server.on("error", function (e) {
    console.log(e);
    process.exit(1);
  });

  server.on("close", function (e) {
    console.log("Cesium development server stopped.");
  });

  let isFirstSig = true;
  process.on("SIGINT", function () {
    if (isFirstSig) {
      console.log("Cesium development server shutting down.");
      server.close(function () {
        process.exit(0);
      });
      isFirstSig = false;
    } else {
      console.log("Cesium development server force kill.");
      process.exit(1);
    }
  });
})();
