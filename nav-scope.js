/**
 * nav-scope.js — read-only navigation visibility for scoped users.
 *
 * A role assignment can be scoped to a project, a location, or a single device.
 * To make a scoped role usable, the user must be able to SEE (read-only) the
 * path that leads to their scope:
 *
 *   • project grant  → see that project and its whole subtree
 *   • location grant → see the project (ancestor), the location's ancestor
 *                        chain, the location itself, and its subtree
 *   • device grant   → see the project + the device's location & ancestor
 *                        chain, and that one device (not sibling devices)
 *
 * These helpers compute those visible id sets from the user's grants. They only
 * govern what a user can BROWSE — what they can read/do with the data is still
 * enforced separately by the permission checks in auth.js/middleware.js.
 */

const { query } = require('./db-helpers');

// ── Raw grants for an active user ──────────────────────────────────────────
async function getUserScope(userId) {
  const rows = await query(
    `SELECT ur.project_id AS PID, ur.location_id AS LID, ur.device_id AS DID
       FROM MODBUS_ADMIN.user_roles ur
       JOIN MODBUS_ADMIN.users u ON u.user_id = ur.user_id
      WHERE u.status = 'active' AND ur.user_id = :userId`,
    { userId }
  );
  const scope = { global: false, projects: new Set(), locations: new Set(), devices: new Set() };
  for (const r of rows) {
    const p = r.PID != null ? Number(r.PID) : null;
    const l = r.LID != null ? Number(r.LID) : null;
    const d = r.DID != null ? Number(r.DID) : null;
    if (p == null && l == null && d == null) scope.global = true;   // fully global grant
    else if (p != null) scope.projects.add(p);
    else if (l != null) scope.locations.add(l);
    else if (d != null) scope.devices.add(d);
  }
  return scope;
}

// Build a named IN-clause + binds from an iterable of values.
function inClause(prefix, values) {
  const arr = [...values];
  const names = arr.map((_, i) => `:${prefix}${i}`);
  const binds = {};
  arr.forEach((v, i) => { binds[`${prefix}${i}`] = v; });
  return { clause: names.join(', '), binds };
}

// Resolve project ids for a set of location ids.
async function projectsOfLocations(locSet) {
  if (!locSet.size) return new Set();
  const { clause, binds } = inClause('l', locSet);
  const rows = await query(
    `SELECT DISTINCT project_id AS P FROM MODBUS_ADMIN.locations WHERE id IN (${clause})`, binds);
  return new Set(rows.map(r => (r.P != null ? Number(r.P) : null)).filter(Boolean));
}

// Resolve { deviceId, locationId, projectId } for a set of device ids.
async function locationsOfDevices(devSet) {
  if (!devSet.size) return [];
  const { clause, binds } = inClause('d', devSet);
  const rows = await query(
    `SELECT d.device_id AS DID, d.location_id AS LID, l.project_id AS P
       FROM MODBUS_ADMIN.devices d
       LEFT JOIN MODBUS_ADMIN.locations l ON l.id = d.location_id
      WHERE d.device_id IN (${clause})`, binds);
  return rows.map(r => ({
    deviceId:   Number(r.DID),
    locationId: r.LID != null ? Number(r.LID) : null,
    projectId:  r.P   != null ? Number(r.P)   : null,
  }));
}

// ── Projects the user may see ──────────────────────────────────────────────
// Returns { global:true } (see all) or { global:false, ids:Set<number> }.
async function visibleProjects(userId) {
  const s = await getUserScope(userId);
  if (s.global) return { global: true, ids: null };
  const ids = new Set(s.projects);
  (await projectsOfLocations(s.locations)).forEach(p => ids.add(p));
  (await locationsOfDevices(s.devices)).forEach(x => { if (x.projectId) ids.add(x.projectId); });
  return { global: false, ids };
}

// ── Locations the user may see inside one project ──────────────────────────
// `items` is the flat list of that project's locations (each has ID / PARENT_ID).
// Returns null → all visible, or a Set of visible location ids (may be empty).
async function visibleLocationIds(userId, projectId, items) {
  const s = await getUserScope(userId);
  if (s.global || s.projects.has(projectId)) return null; // whole project visible

  const byId = new Map(items.map(it => [it.ID, it]));
  const visible = new Set();

  const addAncestors = (id) => {
    let cur = byId.get(id);
    const guard = new Set();
    while (cur && !guard.has(cur.ID)) {
      guard.add(cur.ID);
      visible.add(cur.ID);
      cur = cur.PARENT_ID != null ? byId.get(cur.PARENT_ID) : null;
    }
  };
  const addSubtree = (id) => {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (visible.has(cur) && cur !== id) continue;
      visible.add(cur);
      for (const it of items) if (it.PARENT_ID === cur) stack.push(it.ID);
    }
  };

  // Granted locations that live in this project: show their path + subtree.
  for (const locId of s.locations) {
    if (byId.has(locId)) { addAncestors(locId); addSubtree(locId); }
  }
  // Granted devices whose location is in this project: show the path to it.
  if (s.devices.size) {
    for (const dl of await locationsOfDevices(s.devices)) {
      if (dl.locationId && byId.has(dl.locationId)) addAncestors(dl.locationId);
    }
  }
  return visible;
}

// ── Filter a list of device rows to what the user may see ──────────────────
// `rows` come from a devices query and carry ID and LOCATION_ID.
async function filterVisibleDevices(userId, rows) {
  const s = await getUserScope(userId);
  if (s.global) return rows;

  // Cache location → { projectId, ancestorLocIds } to avoid repeat lookups.
  const locCache = new Map();
  async function locInfo(locationId) {
    if (locCache.has(locationId)) return locCache.get(locationId);
    const ancestors = new Set();
    let projectId = null;
    let cur = locationId;
    const guard = new Set();
    while (cur != null && !guard.has(cur)) {
      guard.add(cur);
      ancestors.add(cur);
      const r = await query(
        `SELECT project_id AS P, parent_id AS PID FROM MODBUS_ADMIN.locations WHERE id = :id`,
        { id: cur });
      if (!r.length) break;
      projectId = r[0].P != null ? Number(r[0].P) : projectId;
      cur = r[0].PID != null ? Number(r[0].PID) : null;
    }
    const info = { projectId, ancestors };
    locCache.set(locationId, info);
    return info;
  }

  const out = [];
  for (const row of rows) {
    const did = row.ID != null ? Number(row.ID) : null;
    const lid = row.LOCATION_ID != null ? Number(row.LOCATION_ID) : null;
    if (did != null && s.devices.has(did)) { out.push(row); continue; }  // granted device
    if (lid == null) continue;
    const info = await locInfo(lid);
    if (info.projectId && s.projects.has(info.projectId)) { out.push(row); continue; } // project grant
    if ([...info.ancestors].some(a => s.locations.has(a)))  { out.push(row); continue; } // location grant covers it
  }
  return out;
}

module.exports = {
  getUserScope,
  visibleProjects,
  visibleLocationIds,
  filterVisibleDevices,
};
