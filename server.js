(async function () {
  "use strict";
  /*jshint node:true*/

  const express = require("express");
  const session = require("express-session");
  const crypto = require("crypto");
  const { socketConnection } = require("./util/io");
  require("dotenv").config();

  const controlRouter = require("./routes/control");

  // ========================================
  // User accounts (in-memory store)
  // In production, replace with database
  // ========================================
  const users = new Map();

  // Hash password helper
  function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  // Seed default users
  users.set('guest', {
    id: 'guest',
    name: 'Guest User',
    email: 'guest@example.com',
    password: hashPassword('guest123'),
    role: 'operator',
    createdAt: new Date().toISOString()
  });
  users.set('admin', {
    id: 'admin',
    name: 'Administrator',
    email: 'admin@atc-drone.io',
    password: hashPassword('admin123'),
    role: 'authority',
    createdAt: new Date().toISOString()
  });

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
  app.use(session({
    secret: process.env.SESSION_SECRET || 'atc-drone-dev-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // Make user available to all views
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
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
    const user = users.get(username);
    const hashedPassword = hashPassword(password);

    if (user && user.password === hashedPassword) {
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      };
      console.log(`[AUTH] User logged in: ${user.id}`);
      return res.redirect('/control');
    }

    res.render('login', { error: 'Invalid username or password' });
  });

  // Guest login (one-click)
  app.post('/login/guest', (req, res) => {
    const guest = users.get('guest');
    req.session.user = {
      id: guest.id,
      name: guest.name,
      email: guest.email,
      role: guest.role,
      createdAt: guest.createdAt
    };
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

    if (users.has(username)) {
      return res.render('signup', {
        error: 'Username already exists',
        success: null
      });
    }

    // Check email uniqueness
    for (const [, user] of users) {
      if (user.email === email) {
        return res.render('signup', {
          error: 'Email already registered',
          success: null
        });
      }
    }

    // Create user
    const newUser = {
      id: username,
      name: name,
      email: email,
      password: hashPassword(password),
      role: 'operator',
      createdAt: new Date().toISOString()
    };
    users.set(username, newUser);
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
    const user = users.get(userId);

    if (user) {
      user.name = name || user.name;
      user.email = email || user.email;
      req.session.user.name = user.name;
      req.session.user.email = user.email;
      console.log(`[AUTH] Profile updated: ${userId}`);
    }
    res.redirect('/control/settings?updated=profile');
  });

  app.post('/account/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    const userId = req.session.user.id;
    const user = users.get(userId);

    if (!user) {
      return res.redirect('/control/settings?error=user_not_found');
    }

    if (user.password !== hashPassword(currentPassword)) {
      return res.redirect('/control/settings?error=wrong_password');
    }

    if (newPassword.length < 6) {
      return res.redirect('/control/settings?error=password_short');
    }

    if (newPassword !== confirmNewPassword) {
      return res.redirect('/control/settings?error=password_mismatch');
    }

    user.password = hashPassword(newPassword);
    console.log(`[AUTH] Password changed: ${userId}`);
    res.redirect('/control/settings?updated=password');
  });

  app.post('/account/delete', requireAuth, (req, res) => {
    const userId = req.session.user.id;

    if (userId === 'guest' || userId === 'admin') {
      return res.redirect('/control/settings?error=cannot_delete');
    }

    users.delete(userId);
    console.log(`[AUTH] Account deleted: ${userId}`);

    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // ========================================
  // Auth middleware for protected routes
  // ========================================
  function requireAuth(req, res, next) {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    next();
  }

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
