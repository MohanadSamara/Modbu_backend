/**
 * auth.js
 *
 * Auth primitives: password hashing, JWT signing/verification, session
 * management (DB-backed refresh tokens), and permission checks.
 *
 * Token strategy:
 *   - Access token : short-lived JWT (15 min), sent in `Authorization: Bearer …`.
 *   - Refresh token: long-lived opaque random string (7 days). The server
 *     stores only sha256(refresh) in MODBUS_ADMIN.user_sessions so a DB leak
 *     can't grant access. Logout = delete the row. Force-logout-all = delete
 *     all rows for that user_id.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const oracledb = require('oracledb');
const { getConnection } = require('./db');

// ── Config ────────────────────────────────────────────────────────────────
const BCRYPT_COST          = 10;
const ACCESS_TOKEN_TTL_SEC = 15 * 60;          // 15 min
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_LOGINS    = 5;
const LOCK_DURATION_MIN    = 15;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn(
    '[Auth] WARNING: JWT_SECRET is missing or too short (<32 chars). ' +
    'Set a strong random value in .env before going to production.'
  );
}
const _SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me-now-please-32+chars';

// ── Password hashing ──────────────────────────────────────────────────────
function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── JWT (access token) ────────────────────────────────────────────────────
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.user_id, username: user.username },
    _SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SEC }
  );
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, _SECRET); // returns payload or throws
  } catch {
    return null;
  }
}

// ── Refresh token (opaque, DB-backed) ─────────────────────────────────────
function _generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex'); // 96 hex chars
}

function _hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a new refresh token row in user_sessions and return the raw token
 * (which is only ever sent to the client — never stored).
 */
async function issueSession(userId, { userAgent, ip } = {}) {
  const raw  = _generateRefreshToken();
  const hash = _hashRefreshToken(raw);
  // Compute the expiry server-side (SYSTIMESTAMP + interval) instead of
  // binding a JS Date — avoids any oracledb TIMESTAMP-bind quirks.
  const ttlSeconds = Math.floor(REFRESH_TOKEN_TTL_MS / 1000);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const conn = await getConnection();
  if (!conn) throw new Error('DB unavailable');
  try {
    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_sessions
          (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES (:userId, :hash, :ua, :ip,
               SYSTIMESTAMP + NUMTODSINTERVAL(:ttl, 'SECOND'))`,
      {
        userId,
        hash,
        ua: (userAgent || '').slice(0, 500),
        ip: (ip || '').slice(0, 64),
        ttl: ttlSeconds,
      },
      { autoCommit: true }
    );
    return { refreshToken: raw, expiresAt };
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Look up a session by its raw refresh token. Returns the row (with user
 * info) if it's valid (not revoked, not expired), else null. Also bumps
 * last_used_at.
 */
async function consumeRefreshToken(rawToken) {
  if (!rawToken) return null;
  const hash = _hashRefreshToken(rawToken);

  const conn = await getConnection();
  if (!conn) return null;
  try {
    const r = await conn.execute(
      `SELECT s.session_id, s.user_id, s.expires_at, s.revoked_at,
              u.username, u.status
         FROM MODBUS_ADMIN.user_sessions s
         JOIN MODBUS_ADMIN.users         u ON u.user_id = s.user_id
        WHERE s.refresh_token_hash = :hash`,
      { hash },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = (r.rows || [])[0];
    if (!row) return null;
    if (row.REVOKED_AT) return null;
    if (new Date(row.EXPIRES_AT).getTime() <= Date.now()) return null;
    if (row.STATUS !== 'active') return null;

    // Bump last_used_at (best-effort; don't block on errors)
    conn.execute(
      `UPDATE MODBUS_ADMIN.user_sessions
          SET last_used_at = SYSTIMESTAMP
        WHERE session_id = :sid`,
      { sid: row.SESSION_ID },
      { autoCommit: true }
    ).catch(() => {});

    return {
      sessionId: row.SESSION_ID,
      userId:    row.USER_ID,
      username:  row.USERNAME,
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Revoke a single session by its raw refresh token. Returns true if a row
 * was deleted/revoked.
 */
async function revokeSessionByToken(rawToken) {
  if (!rawToken) return false;
  const hash = _hashRefreshToken(rawToken);
  const conn = await getConnection();
  if (!conn) return false;
  try {
    const r = await conn.execute(
      `DELETE FROM MODBUS_ADMIN.user_sessions WHERE refresh_token_hash = :hash`,
      { hash },
      { autoCommit: true }
    );
    return (r.rowsAffected || 0) > 0;
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Revoke every session for a user (force logout from all devices). */
async function revokeAllSessions(userId) {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    await conn.execute(
      `DELETE FROM MODBUS_ADMIN.user_sessions WHERE user_id = :userId`,
      { userId },
      { autoCommit: true }
    );
    return true;
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Login / lockout ───────────────────────────────────────────────────────

/**
 * Look up an active user by username OR email.
 */
async function findUserByLogin(login) {
  if (!login) return null;
  const conn = await getConnection();
  if (!conn) return null;
  try {
    const r = await conn.execute(
      `SELECT user_id, username, email, password_hash, full_name, status,
              failed_logins, locked_until
         FROM MODBUS_ADMIN.users
        WHERE LOWER(username) = LOWER(:login)
           OR LOWER(email)    = LOWER(:login)`,
      { login },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (r.rows || [])[0] || null;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function findUserById(userId) {
  const conn = await getConnection();
  if (!conn) return null;
  try {
    const r = await conn.execute(
      `SELECT user_id, username, email, full_name, status, last_login_at, created_at
         FROM MODBUS_ADMIN.users
        WHERE user_id = :userId`,
      { userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (r.rows || [])[0] || null;
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Increment failed_logins; lock the account if over the threshold. */
async function recordFailedLogin(userId) {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(
      `UPDATE MODBUS_ADMIN.users
          SET failed_logins = failed_logins + 1,
              locked_until = CASE
                WHEN failed_logins + 1 >= :maxFails
                THEN SYSTIMESTAMP + NUMTODSINTERVAL(:lockMin, 'MINUTE')
                ELSE locked_until
              END,
              status = CASE
                WHEN failed_logins + 1 >= :maxFails THEN 'locked' ELSE status
              END,
              updated_at = SYSTIMESTAMP
        WHERE user_id = :userId`,
      { userId, maxFails: MAX_FAILED_LOGINS, lockMin: LOCK_DURATION_MIN },
      { autoCommit: true }
    );
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Reset failed_logins on successful login + bump last_login_at. */
async function recordSuccessfulLogin(userId) {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(
      `UPDATE MODBUS_ADMIN.users
          SET failed_logins = 0,
              locked_until  = NULL,
              status        = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
              last_login_at = SYSTIMESTAMP,
              updated_at    = SYSTIMESTAMP
        WHERE user_id = :userId`,
      { userId },
      { autoCommit: true }
    );
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * If `locked_until` has passed, auto-unlock so the user can try again.
 * Returns true if the account is currently locked.
 */
async function isAccountLocked(user) {
  if (user.STATUS !== 'locked') return false;
  if (user.LOCKED_UNTIL && new Date(user.LOCKED_UNTIL).getTime() <= Date.now()) {
    // Expired lock — clear it
    const conn = await getConnection();
    if (conn) {
      try {
        await conn.execute(
          `UPDATE MODBUS_ADMIN.users
              SET status = 'active', failed_logins = 0, locked_until = NULL
            WHERE user_id = :userId`,
          { userId: user.USER_ID },
          { autoCommit: true }
        );
      } finally {
        await conn.close().catch(() => {});
      }
    }
    return false;
  }
  return true;
}

// ── Audit log ─────────────────────────────────────────────────────────────
async function logAudit({ userId, usernameTry, eventType, ip, userAgent, detail }) {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await conn.execute(
      `INSERT INTO MODBUS_ADMIN.user_login_audit
         (user_id, username_try, event_type, ip_address, user_agent, detail)
       VALUES (:userId, :uname, :etype, :ipAddr, :ua, :detail)`,
      {
        userId: userId ?? null,
        uname:  (usernameTry || '').slice(0, 60),
        etype:  eventType,
        ipAddr: (ip || '').slice(0, 64),
        ua:     (userAgent || '').slice(0, 500),
        detail: (detail || '').slice(0, 500),
      },
      { autoCommit: true }
    );
  } catch (err) {
    console.warn('[Auth] audit log failed:', err.message);
  } finally {
    await conn.close().catch(() => {});
  }
}

// ── Permission lookup (inline JOIN — no view needed) ──────────────────────
//
// Cached per (userId, permKey, projectId) for PERMS_CACHE_MS so the same
// request -> middleware -> route doesn't run the JOIN multiple times. Cache
// is invalidated when roles change (see invalidateUserPermsCache).
const _permsCache = new Map(); // `${uid}|${perm}|${pid}` -> { ok, ts }
const PERMS_CACHE_MS = 30_000;

function invalidateUserPermsCache(userId) {
  if (userId === undefined) {
    _permsCache.clear();
    return;
  }
  const prefix = `${userId}|`;
  for (const k of _permsCache.keys()) {
    if (k.startsWith(prefix)) _permsCache.delete(k);
  }
}

async function userHasPermission(userId, permissionKey, projectId = null) {
  const key = `${userId}|${permissionKey}|${projectId ?? ''}`;
  const cached = _permsCache.get(key);
  if (cached && (Date.now() - cached.ts) < PERMS_CACHE_MS) return cached.ok;

  const conn = await getConnection();
  if (!conn) return false;
  try {
    const r = await conn.execute(
      `SELECT 1
         FROM MODBUS_ADMIN.user_roles       ur
         JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
         JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
         JOIN MODBUS_ADMIN.users            u  ON u.user_id       = ur.user_id
        WHERE u.status         = 'active'
          AND ur.user_id       = :userId
          AND p.permission_key = :permKey
          AND (ur.project_id IS NULL OR ur.project_id = :projectId)
          AND ROWNUM = 1`,
      { userId, permKey: permissionKey, projectId: projectId ?? null }
    );
    const ok = (r.rows || []).length > 0;
    _permsCache.set(key, { ok, ts: Date.now() });
    return ok;
  } catch (err) {
    console.error('[Auth] permission check failed:', err.message);
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Return the full permission set for a user (used by /me so the frontend
 * can decide which UI elements to render).
 */
async function getUserRolesAndPermissions(userId) {
  const conn = await getConnection();
  if (!conn) return { roles: [], permissions: [] };
  try {
    const [rolesRes, permsRes] = await Promise.all([
      conn.execute(
        `SELECT r.role_key, r.role_name, ur.project_id
           FROM MODBUS_ADMIN.user_roles ur
           JOIN MODBUS_ADMIN.roles      r ON r.role_id = ur.role_id
          WHERE ur.user_id = :userId`,
        { userId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),
      conn.execute(
        `SELECT DISTINCT p.permission_key, ur.project_id
           FROM MODBUS_ADMIN.user_roles       ur
           JOIN MODBUS_ADMIN.role_permissions rp ON rp.role_id      = ur.role_id
           JOIN MODBUS_ADMIN.permissions      p  ON p.permission_id = rp.permission_id
          WHERE ur.user_id = :userId`,
        { userId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      ),
    ]);
    return {
      roles: (rolesRes.rows || []).map(r => ({
        key: r.ROLE_KEY, name: r.ROLE_NAME, projectId: r.PROJECT_ID,
      })),
      permissions: (permsRes.rows || []).map(r => ({
        key: r.PERMISSION_KEY, projectId: r.PROJECT_ID,
      })),
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

module.exports = {
  // hashing
  hashPassword,
  verifyPassword,
  // tokens
  signAccessToken,
  verifyAccessToken,
  issueSession,
  consumeRefreshToken,
  revokeSessionByToken,
  revokeAllSessions,
  // user lookups
  findUserByLogin,
  findUserById,
  recordFailedLogin,
  recordSuccessfulLogin,
  isAccountLocked,
  // audit
  logAudit,
  // RBAC
  userHasPermission,
  getUserRolesAndPermissions,
  invalidateUserPermsCache,
  // constants
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_MS,
};
