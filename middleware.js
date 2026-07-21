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
const { query } = require('./db-helpers');

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

/**
 * Require `permissionKey`, but ONLY when `bodyField` is present in the request
 * body. Lets a shared route carry a finer-grained gate for one field — e.g.
 * editing a device needs device.write, but touching datakom_did (link/unlink a
 * Datakom Rainbow device) additionally needs datakom.write. Chain it after the
 * route's base guard: requirePermission('device.write'), then this. Assumes an
 * earlier `authenticate` populated req.user.
 */
function requirePermissionIfBodyPresent(bodyField, permissionKey) {
  return async (req, res, next) => {
    if (req.body?.[bodyField] === undefined) return next(); // field not touched → no extra gate
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
      console.error('[Auth] requirePermissionIfBodyPresent error:', err.message);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ============================================================================
// Dynamic, data-driven enforcement.
//
// Admins can map a permission to the API routes it protects (permission_endpoints
// table). This middleware enforces those mappings ADDITIVELY: it can only ADD a
// requirement to a route, never remove the built-in code guard. So a bad mapping
// can't open a protected endpoint or lock anyone out of an un-mapped route.
// ============================================================================
let _endpointCache = { rows: null, at: 0 };
const ENDPOINT_TTL_MS = 10000; // reload mappings at most every 10s

function invalidateEndpointCache() {
  _endpointCache = { rows: null, at: 0 };
}

// Convert an express-style path ('/api/locations/:id') into an anchored regex.
function _patternToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars
    .replace(/\/:[^/]+/g, '/[^/]+');        // :param → one path segment
  return new RegExp('^' + escaped + '/?$');
}

async function _loadEndpoints() {
  const now = Date.now();
  if (_endpointCache.rows && now - _endpointCache.at < ENDPOINT_TTL_MS) {
    return _endpointCache.rows;
  }
  const rows = await query(
    `SELECT permission_key, http_method, path_pattern FROM MODBUS_ADMIN.permission_endpoints`
  );
  const parsed = (rows || []).map((r) => ({
    key: r.PERMISSION_KEY,
    method: String(r.HTTP_METHOD || 'ANY').toUpperCase(),
    regex: _patternToRegex(r.PATH_PATTERN),
  }));
  _endpointCache = { rows: parsed, at: now };
  return parsed;
}

async function enforceMappedPermissions(req, res, next) {
  try {
    if (!req.user) return next(); // unauthenticated → the route's own guard handles it
    const path = req.path || (req.url || '').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();

    const eps = await _loadEndpoints();
    const matched = eps.filter(
      (e) => (e.method === 'ANY' || e.method === method) && e.regex.test(path)
    );
    if (matched.length === 0) return next(); // no mapping for this route

    const keys = [...new Set(matched.map((e) => e.key))];
    const ok = await userHasAnyPermission(req.user.id, keys, _extractScope(req));
    if (!ok) {
      return res.status(403).json({
        error: `Forbidden: missing permission (need one of: ${keys.join(', ')})`,
        code: 'AUTH_FORBIDDEN',
        requiredPermission: keys,
      });
    }
    return next();
  } catch (err) {
    // Fail-open: the built-in code guards still protect routes, so a mapping
    // lookup failure must never take the whole API down.
    console.error('[Auth] enforceMappedPermissions error:', err.message);
    return next();
  }
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  requirePermission,
  requireAnyPermission,
  requirePermissionIfBodyPresent,
  enforceMappedPermissions,
  invalidateEndpointCache,
};
