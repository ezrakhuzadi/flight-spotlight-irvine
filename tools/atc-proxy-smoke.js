#!/usr/bin/env node
"use strict";

const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const querystring = require("querystring");
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

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      resolve(raw);
    });
  });
}

async function withAtcStub({ drones }, fn) {
  const port = await getFreePort();
  const calls = {
    drones: 0,
    commands: []
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/v1/drones") {
      calls.drones += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(drones));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/commands") {
      const raw = await readBody(req);
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch (_) {
        payload = raw;
      }
      calls.commands.push({ payload, headers: req.headers || {} });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not_found" }));
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  try {
    return await fn({ port, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withFrontend({ port, atcPort, allowUnowned }, fn) {
  const dbPath = path.join(os.tmpdir(), `atc-frontend-proxy-smoke-${Date.now()}-${port}.sqlite`);
  const child = spawn("node", ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      USER_DB_PATH: dbPath,
      ATC_ALLOW_DEFAULT_USERS: "1",
      ATC_SERVER_URL: `http://127.0.0.1:${atcPort}`,
      ATC_ADMIN_TOKEN: "test-admin-token",
      ATC_ALLOW_UNOWNED_DRONES: allowUnowned ? "1" : "0",
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
    return await fn({ stdout: () => stdout, stderr: () => stderr });
  } finally {
    child.kill("SIGTERM");
    const exitCode = await Promise.race([
      new Promise((resolve) => child.once("exit", (code) => resolve(code))),
      delay(2000).then(() => null)
    ]);
    if (exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function signupOperator({ port }) {
  const jar = new CookieJar();

  const csrfAnon = await request({ port, method: "GET", path: "/csrf" });
  jar.update(csrfAnon.headers["set-cookie"]);
  assert(csrfAnon.status === 200, "GET /csrf failed");
  const anonToken = parseJson(csrfAnon.body, "GET /csrf").csrfToken;
  assert(typeof anonToken === "string" && anonToken.length > 0, "missing csrfToken");

  const username = `op${Date.now()}`;
  const signupBody = querystring.stringify({
    username,
    email: `${username}@example.com`,
    name: username,
    password: "password123",
    confirmPassword: "password123"
  });

  const signupRes = await request({
    port,
    method: "POST",
    path: "/signup",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(signupBody),
      "X-CSRF-Token": anonToken,
      Cookie: jar.header()
    },
    body: signupBody
  });
  jar.update(signupRes.headers["set-cookie"]);
  assert(signupRes.status === 302, "POST /signup should redirect on success");

  const csrfAuthed = await request({
    port,
    method: "GET",
    path: "/csrf",
    headers: { Cookie: jar.header() }
  });
  jar.update(csrfAuthed.headers["set-cookie"]);
  assert(csrfAuthed.status === 200, "GET /csrf after signup failed");
  const csrfToken = parseJson(csrfAuthed.body, "GET /csrf").csrfToken;
  assert(typeof csrfToken === "string" && csrfToken.length > 0, "missing auth csrfToken");

  return { jar, csrfToken, username };
}

async function main() {
  const drones = [
    { drone_id: "other", owner_id: "other-user" },
    { drone_id: "unowned", owner_id: null }
  ];

  await withAtcStub(
    {
      drones
    },
    async ({ port: atcPort, calls }) => {
      // Run strict mode (default): unowned + unknown drones forbidden.
      const frontendPort = await getFreePort();
      await withFrontend(
        { port: frontendPort, atcPort, allowUnowned: false },
        async () => {
          const { jar, csrfToken, username } = await signupOperator({ port: frontendPort });

          assert(typeof username === "string" && username.length > 0, "operator username missing");
          drones.push({ drone_id: "mine", owner_id: username });

          // Path canonicalization: reject encoded separators and dot segments.
          const encodedSlash = await request({
            port: frontendPort,
            method: "GET",
            path: "/api/atc/v1/drones/abc%2Fdef",
            headers: { Cookie: jar.header() }
          });
          assert(encodedSlash.status === 400, "encoded slash path should be rejected");

          const dotSeg = await request({
            port: frontendPort,
            method: "GET",
            path: "/api/atc/v1/drones/..",
            headers: { Cookie: jar.header() }
          });
          assert(dotSeg.status === 400, "dot-segment path should be rejected");

          const encodedBackslash = await request({
            port: frontendPort,
            method: "GET",
            path: "/api/atc/v1/drones/abc%5Cdef",
            headers: { Cookie: jar.header() }
          });
          assert(encodedBackslash.status === 400, "encoded backslash path should be rejected");

          // Ownership: operator must not issue commands to unknown/unowned/other-owned drones.
          const startCommands = calls.commands.length;

          const otherOwned = await request({
            port: frontendPort,
            method: "POST",
            path: "/api/atc/v1/commands",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
              Cookie: jar.header()
            },
            body: JSON.stringify({ drone_id: "other", type: "noop" })
          });
          assert(otherOwned.status === 403, "operator should be forbidden from commanding other-owned drone");
          assert(calls.commands.length === startCommands, "proxy should not forward forbidden commands");

          const unknownDrone = await request({
            port: frontendPort,
            method: "POST",
            path: "/api/atc/v1/commands",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
              Cookie: jar.header()
            },
            body: JSON.stringify({ drone_id: "unknown", type: "noop" })
          });
          assert(unknownDrone.status === 403, "operator should be forbidden from commanding unknown drone");
          assert(calls.commands.length === startCommands, "proxy should not forward unknown drone commands");

          const unownedDrone = await request({
            port: frontendPort,
            method: "POST",
            path: "/api/atc/v1/commands",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
              Cookie: jar.header()
            },
            body: JSON.stringify({ drone_id: "unowned", type: "noop" })
          });
          assert(unownedDrone.status === 403, "operator should be forbidden from commanding unowned drone by default");
          assert(calls.commands.length === startCommands, "proxy should not forward unowned drone commands");

          const mineDrone = await request({
            port: frontendPort,
            method: "POST",
            path: "/api/atc/v1/commands",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
              Cookie: jar.header()
            },
            body: JSON.stringify({ drone_id: "mine", type: "noop" })
          });
          assert(mineDrone.status === 200, "operator should be able to command own drone");
          assert(calls.commands.length === startCommands + 1, "proxy should forward allowed command");
          const forwarded = calls.commands[calls.commands.length - 1];
          assert(
            forwarded?.headers?.authorization === "Bearer test-admin-token",
            "proxy should inject admin token upstream"
          );
        }
      );

      // Run permissive mode explicitly: allow unowned drones (dev-only).
      const frontendPort2 = await getFreePort();
      await withFrontend(
        { port: frontendPort2, atcPort, allowUnowned: true },
        async () => {
          const { jar, csrfToken } = await signupOperator({ port: frontendPort2 });

          const startCommands = calls.commands.length;

          const unownedDrone = await request({
            port: frontendPort2,
            method: "POST",
            path: "/api/atc/v1/commands",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
              Cookie: jar.header()
            },
            body: JSON.stringify({ drone_id: "unowned", type: "noop" })
          });
          assert(unownedDrone.status === 200, "unowned drone command should be allowed when ATC_ALLOW_UNOWNED_DRONES=1");
          assert(calls.commands.length === startCommands + 1, "proxy should forward unowned drone command in dev mode");
        }
      );
    }
  );

  process.stdout.write("ATC proxy smoke checks passed.\\n");
}

main().catch((error) => {
  process.stderr.write(`ATC proxy smoke checks failed: ${error.message}\\n`);
  process.exit(1);
});
