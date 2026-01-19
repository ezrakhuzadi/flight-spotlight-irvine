const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "users.sqlite");
const LEGACY_JSON = "users.json";

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    passwordAlgo: row.password_algo,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

function migrateLegacyJson(dbPath, db) {
  const legacyPath = path.join(path.dirname(dbPath), LEGACY_JSON);
  if (!fs.existsSync(legacyPath)) return;
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  } catch (error) {
    return;
  }
  const users = Array.isArray(legacy?.users) ? legacy.users : [];
  if (users.length === 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (
      id,
      name,
      email,
      password_hash,
      password_algo,
      role,
      created_at,
      updated_at,
      last_login_at
    ) VALUES (
      @id,
      @name,
      @email,
      @password_hash,
      @password_algo,
      @role,
      @created_at,
      @updated_at,
      @last_login_at
    )
  `);

  const now = new Date().toISOString();
  const rows = users
    .map((user) => ({
      id: user.id,
      name: user.name || user.id,
      email: user.email || `${user.id}@example.com`,
      password_hash: user.passwordHash || user.password_hash || "",
      password_algo: user.passwordAlgo || user.password_algo || "sha256",
      role: user.role || "operator",
      created_at: user.createdAt || user.created_at || now,
      updated_at: user.updatedAt || user.updated_at || now,
      last_login_at: user.lastLoginAt || user.last_login_at || null
    }))
    .filter((row) => row.id && row.email && row.password_hash);

  if (rows.length === 0) return;
  const txn = db.transaction(() => {
    rows.forEach((row) => insert.run(row));
  });
  txn();
}

function initUserStore(options = {}) {
  const dbPath = options.dbPath || process.env.USER_DB_PATH || DEFAULT_DB_PATH;
  ensureDirectory(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_algo TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  `);

  migrateLegacyJson(dbPath, db);

  const statements = {
    getById: db.prepare("SELECT * FROM users WHERE id = ?"),
    getByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    insert: db.prepare(`
      INSERT INTO users (
        id,
        name,
        email,
        password_hash,
        password_algo,
        role,
        created_at,
        updated_at,
        last_login_at
      ) VALUES (
        @id,
        @name,
        @email,
        @password_hash,
        @password_algo,
        @role,
        @created_at,
        @updated_at,
        @last_login_at
      )
    `),
    updateProfile: db.prepare(`
      UPDATE users
      SET name = @name,
          email = @email,
          updated_at = @updated_at
      WHERE id = @id
    `),
    updatePassword: db.prepare(`
      UPDATE users
      SET password_hash = @password_hash,
          password_algo = @password_algo,
          updated_at = @updated_at
      WHERE id = @id
    `),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    touchLogin: db.prepare(`
      UPDATE users
      SET last_login_at = @last_login_at,
          updated_at = @updated_at
      WHERE id = @id
    `)
  };

  function getUserById(id) {
    return normalizeUser(statements.getById.get(id));
  }

  function getUserByEmail(email) {
    return normalizeUser(statements.getByEmail.get(email));
  }

  function createUser({ id, name, email, passwordHash, passwordAlgo, role }) {
    const timestamp = new Date().toISOString();
    statements.insert.run({
      id,
      name,
      email,
      password_hash: passwordHash,
      password_algo: passwordAlgo,
      role,
      created_at: timestamp,
      updated_at: timestamp,
      last_login_at: null
    });
    return getUserById(id);
  }

  function updateProfile(id, { name, email }) {
    const timestamp = new Date().toISOString();
    statements.updateProfile.run({
      id,
      name,
      email,
      updated_at: timestamp
    });
    return getUserById(id);
  }

  function updatePassword(id, passwordHash, passwordAlgo) {
    const timestamp = new Date().toISOString();
    statements.updatePassword.run({
      id,
      password_hash: passwordHash,
      password_algo: passwordAlgo,
      updated_at: timestamp
    });
  }

  function deleteUser(id) {
    statements.deleteUser.run(id);
  }

  function touchLogin(id) {
    const timestamp = new Date().toISOString();
    statements.touchLogin.run({
      id,
      last_login_at: timestamp,
      updated_at: timestamp
    });
  }

  function ensureDefaults(hashPassword, passwordAlgo, seedUsers = []) {
    const defaults = Array.isArray(seedUsers) ? seedUsers : [];

    defaults.forEach((user) => {
      const existing = getUserById(user.id);
      if (existing) return;
      createUser({
        id: user.id,
        name: user.name,
        email: user.email,
        passwordHash: hashPassword(user.password),
        passwordAlgo,
        role: user.role
      });
    });
  }

  return {
    dbPath,
    getUserById,
    getUserByEmail,
    createUser,
    updateProfile,
    updatePassword,
    deleteUser,
    touchLogin,
    ensureDefaults
  };
}

module.exports = { initUserStore };
