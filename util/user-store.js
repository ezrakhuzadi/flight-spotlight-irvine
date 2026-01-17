const fs = require("fs");
const path = require("path");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "users.json");

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readDb(dbPath) {
  try {
    const raw = fs.readFileSync(dbPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return { users: [] };
  }
}

function writeDb(dbPath, data) {
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, dbPath);
}

function cloneUser(user) {
  return user ? { ...user } : null;
}

function initUserStore(options = {}) {
  const dbPath = options.dbPath || process.env.USER_DB_PATH || DEFAULT_DB_PATH;
  ensureDirectory(dbPath);
  if (!fs.existsSync(dbPath)) {
    writeDb(dbPath, { users: [] });
  }

  function getUserById(id) {
    const data = readDb(dbPath);
    return cloneUser(data.users.find((user) => user.id === id) || null);
  }

  function getUserByEmail(email) {
    const data = readDb(dbPath);
    return cloneUser(data.users.find((user) => user.email === email) || null);
  }

  function createUser({ id, name, email, passwordHash, role }) {
    const data = readDb(dbPath);
    const timestamp = new Date().toISOString();
    const user = {
      id,
      name,
      email,
      passwordHash,
      role,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null
    };
    data.users.push(user);
    writeDb(dbPath, data);
    return cloneUser(user);
  }

  function updateProfile(id, { name, email }) {
    const data = readDb(dbPath);
    const user = data.users.find((entry) => entry.id === id);
    if (!user) {
      return null;
    }
    user.name = name;
    user.email = email;
    user.updatedAt = new Date().toISOString();
    writeDb(dbPath, data);
    return cloneUser(user);
  }

  function updatePassword(id, passwordHash) {
    const data = readDb(dbPath);
    const user = data.users.find((entry) => entry.id === id);
    if (!user) {
      return;
    }
    user.passwordHash = passwordHash;
    user.updatedAt = new Date().toISOString();
    writeDb(dbPath, data);
  }

  function deleteUser(id) {
    const data = readDb(dbPath);
    data.users = data.users.filter((user) => user.id !== id);
    writeDb(dbPath, data);
  }

  function touchLogin(id) {
    const data = readDb(dbPath);
    const user = data.users.find((entry) => entry.id === id);
    if (!user) {
      return;
    }
    const timestamp = new Date().toISOString();
    user.lastLoginAt = timestamp;
    user.updatedAt = timestamp;
    writeDb(dbPath, data);
  }

  function ensureDefaults(hashPassword) {
    const defaults = [
      {
        id: "guest",
        name: "Guest User",
        email: "guest@example.com",
        passwordHash: hashPassword("guest123"),
        role: "operator"
      },
      {
        id: "admin",
        name: "Administrator",
        email: "admin@atc-drone.io",
        passwordHash: hashPassword("admin123"),
        role: "authority"
      }
    ];
    const data = readDb(dbPath);
    let changed = false;
    defaults.forEach((user) => {
      const existing = data.users.find((entry) => entry.id === user.id);
      if (!existing) {
        data.users.push({
          ...user,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastLoginAt: null
        });
        changed = true;
      }
    });
    if (changed) {
      writeDb(dbPath, data);
    }
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
