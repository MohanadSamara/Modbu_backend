/**
 * middleware.js
 *
 * Express middleware:
 *   - authenticate         : verifies Bearer JWT, attaches req.user
 *   - optionalAuthenticate : same but doesn't 401 if missing
 *   - requirePermission(k) : 403 unless req.user has permission `k`
 *                            (project_id auto-extracted from req.body /
 *                            req.params / req.query when relevant)
 */

const { verifyAccessToken, userHasPermission, userHasAnyPermission } = require('./auth');

/**
 * Pull the scope the request targets out of body / params / query.
 * Roles can be scoped to a project, a location, or a single device; a request
 * carries whichever ids it operates on. userHasPermission then widens this to
 * the full chain (a device belongs to a location belongs to a project).
 */
function _extractScope(req) {
  const num = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return {
    projectId:
      num(req.body?.project_id) || num(req.params?.projectId) || num(req.query?.project_id) || null,
    locationId:
      num(req.body?.location_id) || num(req.params?.locationId) || num(req.query?.location_id) || null,
    deviceId:
      num(req.body?.device_id) || num(req.params?.deviceId) || num(req.query?.device_id) || null,
  };
}

function _extractToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function authenticate(req, res, next) {
  const token = _extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing access token', code: 'AUTH_MISSING' });
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired access token', code: 'AUTH_INVALID' });
  }
  req.user = { id: payload.sub, username: payload.username };
  next();
}

function optionalAuthenticate(req, _res, next) {
  const token = _extractToken(req);
  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) req.user = { id: payload.sub, username: payload.username };
  }
  next();
}

/**
 * Require a permission. If the request targets a specific project (via
 * project_id in body/params/query) the check is scoped to that project —
 * meaning a global grant (project_id NULL in user_roles) OR a matching
 * project-scoped grant will pass.
 */
function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_MISSING' });
    }

    try {
      const ok = await userHasPermission(req.user.id, permissionKey, _extractScope(req));
      if (!ok) {
        return res.status(403).json({
          error: `Forbidden: missing permission ${permissionKey}`,
          code: 'AUTH_FORBIDDEN',
          requiredPermission: permissionKey,
        });
      }
      next();
    } catch (err) {
      console.error('[Auth] requirePermission error:', err.message);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

/**
 * Pass if the user holds ANY of `permissionKeys` for the request's scope.
 * Used where a granular key and a legacy bundled key are both acceptable —
 * e.g. START is allowed by either 'device.start' or the legacy 'device.control'.
 */
function requireAnyPermission(permissionKeys) {
  const keys = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_MISSING' });
    }

    try {
      const ok = await userHasAnyPermission(req.user.id, keys, _extractScope(req));
      if (!ok) {
        return res.status(403).json({
          error: `Forbidden: missing permission (need one of: ${keys.join(', ')})`,
          code: 'AUTH_FORBIDDEN',
          requiredPermission: keys,
        });
      }
      next();
    } catch (err) {
      console.error('[Auth] requireAnyPermission error:', err.message);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

module.exports = { authenticate, optionalAuthenticate, requirePermission, requireAnyPermission };
