function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  return next();
}

function requireRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).render("access-denied", {
        user: req.session.user,
        requiredRoles: allowedRoles
      });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
