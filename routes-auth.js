/**
 * routes-auth.js
 *
 * Endpoints:
 *   POST /api/auth/login           { login, password } -> { accessToken, refreshToken, user }
 *   POST /api/auth/refresh         { refreshToken }    -> { accessToken, refreshToken }
 *   POST /api/auth/logout          { refreshToken }    -> { success }
 *   POST /api/auth/logout-all      (auth)              -> { success } -- revokes every session for this user
 *   GET  /api/auth/me              (auth)              -> user + roles + permissions
 *   POST /api/auth/change-password (auth) { current, new } -> { success }
 *
 * Note: there is intentionally NO public /register endpoint. Admin-only
 * user creation lives in routes-users.js (POST /api/users with permission
 * `user.write`).
 */

const express = require('express');
const oracledb = require('oracledb');
const router = express.Router();

const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  issueSession,
  consumeRefreshToken,
  revokeSessionByToken,
  revokeAllSessions,
  findUserByLogin,
  findUserById,
  recordFailedLogin,
  recordSuccessfulLogin,
  isAccountLocked,
  logAudit,
  getUserRolesAndPermissions,
  invalidateUserPermsCache,
  ACCESS_TOKEN_TTL_SEC,
} = require('./auth');
const { getConnection } = require('./db');
const { authenticate } = require('./middleware');

function _meta(req) {
  return {
    ip: req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip,
    userAgent: req.headers['user-agent'] || '',
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { login, password } = req.body || {};
  const { ip, userAgent } = _meta(req);

  if (!login || !password) {
    return res.status(400).json({ error: 'login and password are required' });
  }

  try {
    const user = await findUserByLogin(login);
    if (!user) {
      await logAudit({ usernameTry: login, eventType: 'LOGIN_FAIL', ip, userAgent, detail: 'user not found' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.STATUS === 'disabled') {
      await logAudit({ userId: user.USER_ID, usernameTry: login, eventType: 'LOGIN_FAIL', ip, userAgent, detail: 'account disabled' });
      return res.status(403).json({ error: 'Account is disabled' });
    }

    if (await isAccountLocked(user)) {
      await logAudit({ userId: user.USER_ID, usernameTry: login, eventType: 'LOGIN_FAIL', ip, userAgent, detail: 'account locked' });
      return res.status(423).json({
        error: 'Account is locked due to too many failed attempts. Try again later.',
        code: 'AUTH_LOCKED',
      });
    }

    const ok = await verifyPassword(password, user.PASSWORD_HASH);
    if (!ok) {
      await recordFailedLogin(user.USER_ID);
      await logAudit({ userId: user.USER_ID, usernameTry: login, eventType: 'LOGIN_FAIL', ip, userAgent, detail: 'bad password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Success — reset counters, issue tokens
    await recordSuccessfulLogin(user.USER_ID);
    const accessToken = signAccessToken({ user_id: user.USER_ID, username: user.USERNAME });
    const { refreshToken, expiresAt } = await issueSession(user.USER_ID, { ip, userAgent });

    await logAudit({ userId: user.USER_ID, usernameTry: login, eventType: 'LOGIN_OK', ip, userAgent });

    res.json({
      accessToken,
      refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SEC,
      refreshTokenExpiresAt: expiresAt,
      user: {
        id:       user.USER_ID,
        username: user.USERNAME,
        email:    user.EMAIL,
        fullName: user.FULL_NAME,
      },
    });
  } catch (err) {
    console.error('POST /api/auth/login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────
// Rotates the refresh token (old one is deleted, new one issued).
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  const { ip, userAgent } = _meta(req);

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const session = await consumeRefreshToken(refreshToken);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'AUTH_INVALID' });
    }

    // Rotate: delete old, issue new
    await revokeSessionByToken(refreshToken);
    const accessToken = signAccessToken({ user_id: session.userId, username: session.username });
    const { refreshToken: newRefresh, expiresAt } = await issueSession(session.userId, { ip, userAgent });

    res.json({
      accessToken,
      refreshToken: newRefresh,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SEC,
      refreshTokenExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error('POST /api/auth/refresh error:', err.message);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────
// Idempotent: succeeds even if the token is already gone.
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  const { ip, userAgent } = _meta(req);

  try {
    if (refreshToken) {
      // Look up first so we can audit which user logged out
      const session = await consumeRefreshToken(refreshToken).catch(() => null);
      await revokeSessionByToken(refreshToken);
      if (session) {
        await logAudit({ userId: session.userId, eventType: 'LOGOUT', ip, userAgent });
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/logout error:', err.message);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── POST /api/auth/logout-all ─────────────────────────────────────────────
// Force-logout from every device. Requires a valid access token.
router.post('/logout-all', authenticate, async (req, res) => {
  const { ip, userAgent } = _meta(req);
  try {
    await revokeAllSessions(req.user.id);
    await logAudit({ userId: req.user.id, eventType: 'LOGOUT', ip, userAgent, detail: 'logout-all' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/logout-all error:', err.message);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const [user, rp] = await Promise.all([
      findUserById(req.user.id),
      getUserRolesAndPermissions(req.user.id),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id:          user.USER_ID,
      username:    user.USERNAME,
      email:       user.EMAIL,
      fullName:    user.FULL_NAME,
      status:      user.STATUS,
      lastLoginAt: user.LAST_LOGIN_AT,
      createdAt:   user.CREATED_AT,
      roles:       rp.roles,
      permissions: rp.permissions,
    });
  } catch (err) {
    console.error('GET /api/auth/me error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── POST /api/auth/change-password ────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const { ip, userAgent } = _meta(req);

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const conn = await getConnection();
  if (!conn) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const r = await conn.execute(
      `SELECT password_hash FROM MODBUS_ADMIN.users WHERE user_id = :userId`,
      { userId: req.user.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = (r.rows || [])[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    const ok = await verifyPassword(currentPassword, row.PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await hashPassword(newPassword);
    await conn.execute(
      `UPDATE MODBUS_ADMIN.users
          SET password_hash = :newHash,
              password_changed_at = SYSTIMESTAMP,
              updated_at = SYSTIMESTAMP
        WHERE user_id = :userId`,
      { newHash, userId: req.user.id },
      { autoCommit: true }
    );

    // Force re-login on every other device
    await revokeAllSessions(req.user.id);
    invalidateUserPermsCache(req.user.id);
    await logAudit({ userId: req.user.id, eventType: 'PASSWORD_CHANGE', ip, userAgent });

    res.json({ success: true, message: 'Password updated. Please log in again.' });
  } catch (err) {
    console.error('POST /api/auth/change-password error:', err.message);
    res.status(500).json({ error: 'Password change failed' });
  } finally {
    await conn.close().catch(() => {});
  }
});

module.exports = router;
