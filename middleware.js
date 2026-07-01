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

const { verifyAccessToken, userHasPermission } = require('./auth');

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

    const projectId =
      Number(req.body?.project_id) ||
      Number(req.params?.projectId) ||
      Number(req.query?.project_id) ||
      null;

    try {
      const ok = await userHasPermission(req.user.id, permissionKey, projectId || null);
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

module.exports = { authenticate, optionalAuthenticate, requirePermission };
