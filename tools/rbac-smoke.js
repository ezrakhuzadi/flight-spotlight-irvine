#!/usr/bin/env node
"use strict";

const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address !== "object") {
          reject(new Error("Failed to resolve ephemeral port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  update(setCookieHeaders) {
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
    for (const header of headers) {
      const first = typeof header === "string" ? header.split(";")[0] : "";
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  header() {
    if (this.cookies.size === 0) return "";
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

function request({ port, method, path: reqPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: data
        });
      });
    });

    req.on("error", reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

async function waitForServer(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request({ port, method: "GET", path: "/csrf" });
      if (res.status === 200) return;
    } catch (_) {
      // ignore
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for frontend server to start");
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} returned non-JSON body`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const port = await getFreePort();
  const dbPath = path.join(os.tmpdir(), `atc-frontend-smoke-${Date.now()}-${port}.sqlite`);

  const child = spawn("node", ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      USER_DB_PATH: dbPath,
      ATC_ALLOW_DEFAULT_USERS: "1",
      ATC_SERVER_URL: "http://127.0.0.1:9",
      BLENDER_URL: "http://127.0.0.1:9"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForServer(port, 10_000);

    const jar = new CookieJar();

    // Establish anonymous session + CSRF token
    const csrfAnon = await request({ port, method: "GET", path: "/csrf" });
    jar.update(csrfAnon.headers["set-cookie"]);
    assert(csrfAnon.status === 200, "GET /csrf failed");
    const anonToken = parseJson(csrfAnon.body, "GET /csrf").csrfToken;
    assert(typeof anonToken === "string" && anonToken.length > 0, "missing csrfToken");

    // Login as guest (viewer)
    const guestLogin = await request({
      port,
      method: "POST",
      path: "/login/guest",
      headers: {
        "X-CSRF-Token": anonToken,
        Cookie: jar.header()
      }
    });
    jar.update(guestLogin.headers["set-cookie"]);
    assert(guestLogin.status === 302, "POST /login/guest should redirect on success");

    // Get CSRF token for authenticated session
    const csrfAuthed = await request({
      port,
      method: "GET",
      path: "/csrf",
      headers: { Cookie: jar.header() }
    });
    jar.update(csrfAuthed.headers["set-cookie"]);
    assert(csrfAuthed.status === 200, "GET /csrf after login failed");
    const csrfToken = parseJson(csrfAuthed.body, "GET /csrf").csrfToken;
    assert(typeof csrfToken === "string" && csrfToken.length > 0, "missing auth csrfToken");

    // Viewer must not be able to perform state-changing actions.
    const forbiddenDeclaration = await request({
      port,
      method: "POST",
      path: "/api/blender/flight-declarations",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: jar.header()
      },
      body: "{}"
    });
    assert(
      forbiddenDeclaration.status === 403,
      "viewer should be forbidden from POST /api/blender/flight-declarations"
    );

    const forbiddenDelete = await request({
      port,
      method: "DELETE",
      path: "/api/blender/flight-declarations/test-id",
      headers: {
        "X-CSRF-Token": csrfToken,
        Cookie: jar.header()
      }
    });
    assert(
      forbiddenDelete.status === 403,
      "viewer should be forbidden from DELETE /api/blender/flight-declarations/:id"
    );

    const forbiddenDroneRegister = await request({
      port,
      method: "POST",
      path: "/api/atc/v1/drones/register",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: jar.header()
      },
      body: "{}"
    });
    assert(
      forbiddenDroneRegister.status === 403,
      "viewer should be forbidden from POST /api/atc/v1/drones/register"
    );

    // Viewer should still be able to hit compute-only endpoints (even if upstream is down).
    const plannerProbe = await request({
      port,
      method: "POST",
      path: "/api/atc/v1/routes/plan",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: jar.header()
      },
      body: "{}"
    });
    assert(
      plannerProbe.status !== 403,
      "viewer should not be role-blocked from POST /api/atc/v1/routes/plan"
    );

    process.stdout.write("RBAC smoke checks passed.\n");
  } finally {
    if (!child.killed) {
      child.kill();
    }
    await Promise.race([new Promise((resolve) => child.on("exit", resolve)), delay(2000)]);
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
    if (child.exitCode && child.exitCode !== 0) {
      process.stderr.write(stdout);
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[FAIL] ${error.message}\n`);
  process.exit(1);
});

