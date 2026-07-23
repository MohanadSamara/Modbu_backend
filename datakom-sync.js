/**
 * datakom-sync.js — Datakom cloud→DB sync job.
 *
 * Materialises the Datakom Rainbow cloud tree (datakom-rainbow.js) into REAL
 * projects/locations/devices rows so everything is editable like any other
 * project (rename, move, add IP, delete…). Runs on a cadence once the adapter
 * is ready, plus on demand via POST /api/brands/datakom/sync.
 *
 * Mapping model:
 *   cloud root node          → project (brand=Datakom, method='cloud')
 *                              + a default location under it (devices of the
 *                                root node itself land there)
 *   cloud child node         → location (nested by parent_id)
 *   ungrouped cloud devices  → project "Datakom (Ungrouped)" / location "Ungrouped"
 *   legacy container folders → container project (parent of root-node projects)
 *
 * Idempotency / user-edit protection (the core rules):
 *   - Nodes are matched via datakom_node_map, devices via datakom_did_map —
 *     NEVER by name. The sync only CREATES missing rows; it never renames,
 *     re-parents or overwrites an existing mapped entity, so user edits stick.
 *   - A map row whose entity row was deleted is a tombstone: the user deleted
 *     it on purpose, so it is never recreated.
 *   - The one allowed update: fill a device's GPS from the cloud when BOTH
 *     coordinates are currently NULL.
 *   - First sync seeds names/folders from the legacy datakom_node_names /
 *     datakom_node_containers tables (the old read-only-tree customisations).
 *
 * Config: DK_SYNC_MS (default 10 min, min 1 min) — cadence between syncs.
 */

const oracledb = require('oracledb');
const { getConnection, getDatakomNodeNames, getDatakomNodeContainers } = require('./db');
const datakom = require('./datakom-rainbow');

const SYNC_MS = Math.max(60_000, Number(process.env.DK_SYNC_MS) || 600_000);
const TICK_MS = 30_000; // loop granularity (first sync fires soon after ready)

let refreshDidMapCb = null;   // provided by index.js (rebuilds did→device_id cache)
let running = false;
let lastRun = null;           // { at, summary } of the last completed run
let lastError = null;
let loopTimer = null;

function configure({ refreshDidMap } = {}) {
  if (typeof refreshDidMap === 'function') refreshDidMapCb = refreshDidMap;
}

function getSyncStatus() {
  return {
    running,
    intervalMs: SYNC_MS,
    lastRunAt: lastRun?.at ?? null,
    lastSummary: lastRun?.summary ?? null,
    lastError,
  };
}

// ── Small SQL helpers on a shared connection (autoCommit off) ───────────────
async function q(conn, sql, binds = {}) {
  const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows || [];
}

const isUnique = (e) => /ORA-00001|unique constraint/i.test(e?.message || '');

// Insert an entity whose name must be unique; on a name collision retry with
// " (Datakom)" and then " (<tag>)" so one clash never fails the whole run.
async function insertWithNameFallback(conn, tag, baseName, tryInsert) {
  const candidates = [baseName, `${baseName} (Datakom)`, `${baseName} (${tag})`];
  let lastErr = null;
  for (const name of candidates) {
    try { return await tryInsert(name); }
    catch (e) { if (!isUnique(e)) throw e; lastErr = e; }
  }
  throw lastErr;
}

// ── Entity creators (each commits together with its map row) ────────────────
async function createProject(conn, summary, { nodeKey, name, brandId, parentId }) {
  const out = await insertWithNameFallback(conn, nodeKey, name, async (nm) => conn.execute(
    `INSERT INTO MODBUS_ADMIN.projects (name, description, brand_id, method, parent_id)
     VALUES (:name, NULL, :brandId, :method, :parentId)
     RETURNING id INTO :id`,
    { name: nm, brandId, method: brandId != null ? 'cloud' : 'ip', parentId,
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
    { autoCommit: false }
  ));
  const id = out.outBinds.id[0];
  await conn.execute(
    `INSERT INTO MODBUS_ADMIN.datakom_node_map (node_key, entity_type, entity_id)
     VALUES (:nodeKey, 'project', :id)`,
    { nodeKey, id }, { autoCommit: false }
  );
  await conn.commit();
  summary.createdProjects += 1;
  return id;
}

async function createLocation(conn, summary, { nodeKey, name, projectId, parentLocationId }) {
  const out = await insertWithNameFallback(conn, nodeKey, name, async (nm) => conn.execute(
    `INSERT INTO MODBUS_ADMIN.locations (project_id, name, description, address, parent_id)
     VALUES (:projectId, :name, NULL, NULL, :parentId)
     RETURNING id INTO :id`,
    { projectId, name: nm, parentId: parentLocationId,
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
    { autoCommit: false }
  ));
  const id = out.outBinds.id[0];
  await conn.execute(
    `INSERT INTO MODBUS_ADMIN.datakom_node_map (node_key, entity_type, entity_id)
     VALUES (:nodeKey, 'location', :id)`,
    { nodeKey, id }, { autoCommit: false }
  );
  await conn.commit();
  summary.createdLocations += 1;
  return id;
}

async function createDevice(conn, summary, nextDeviceId, dev, locationId, brandId) {
  const deviceId = nextDeviceId();
  const name = (dev.sid && String(dev.sid).trim()) || `Datakom ${dev.did}`;
  const lat = Number.isFinite(Number(dev.lat)) ? Number(dev.lat) : null;
  const lng = Number.isFinite(Number(dev.lng)) ? Number(dev.lng) : null;
  const ip  = dev.ip || null; // cloud-reported IP, if the device reports one
  await conn.execute(
    `INSERT INTO MODBUS_ADMIN.DEVICES
       (device_id, device_name, device_ip, device_port, status, location_id,
        brand_id, datakom_did, latitude, longitude${lat != null || lng != null ? ', gps_updated_at' : ''})
     VALUES
       (:deviceId, :name, :ip, 502, 'offline', :locationId,
        :brandId, :did, :lat, :lng${lat != null || lng != null ? ', SYSTIMESTAMP' : ''})`,
    { deviceId, name, ip, locationId, brandId, did: dev.did, lat, lng },
    { autoCommit: false }
  );
  await conn.execute(
    `INSERT INTO MODBUS_ADMIN.datakom_did_map (did, device_id) VALUES (:did, :deviceId)`,
    { did: dev.did, deviceId }, { autoCommit: false }
  );
  await conn.commit();
  summary.createdDevices += 1;
  return deviceId;
}

// ── The sync run ────────────────────────────────────────────────────────────
async function runSync() {
  if (running) return { skipped: 'already running' };
  if (!datakom.isReady()) return { skipped: 'adapter not ready' };
  running = true;
  const summary = {
    createdProjects: 0, createdLocations: 0, createdDevices: 0,
    updatedGps: 0, tombstoned: 0, errors: [],
  };
  let conn = null;
  try {
    const tree = datakom.getTree();
    conn = await getConnection();
    if (!conn) throw new Error('DB unavailable');

    // Existing anchors: node_key|entity_type → entity_id, and the set of
    // already-imported dids (tombstones included).
    const nodeMap = new Map();
    for (const r of await q(conn, `SELECT node_key, entity_type, entity_id FROM MODBUS_ADMIN.datakom_node_map`)) {
      nodeMap.set(`${r.NODE_KEY}|${r.ENTITY_TYPE}`, Number(r.ENTITY_ID));
    }
    const didRows = await q(conn, `SELECT did, device_id FROM MODBUS_ADMIN.datakom_did_map`);
    const knownDids = new Map(didRows.map((r) => [Number(r.DID), r.DEVICE_ID == null ? null : Number(r.DEVICE_ID)]));

    // A did already linked to ANY existing device row (e.g. manually created
    // before the sync existed) counts as imported — never auto-create a
    // duplicate of a device the user already added. Backfill the map so the
    // rule also holds after that device is later deleted (tombstone).
    const linkedRows = await q(conn, `SELECT device_id, datakom_did FROM MODBUS_ADMIN.DEVICES WHERE datakom_did IS NOT NULL`);
    for (const r of linkedRows) {
      const did = Number(r.DATAKOM_DID);
      if (!knownDids.has(did)) {
        try {
          await conn.execute(
            `INSERT INTO MODBUS_ADMIN.datakom_did_map (did, device_id) VALUES (:did, :deviceId)`,
            { did, deviceId: Number(r.DEVICE_ID) }, { autoCommit: true }
          );
          knownDids.set(did, Number(r.DEVICE_ID));
        } catch { knownDids.set(did, Number(r.DEVICE_ID)); }
      }
    }

    // Live entity sets — a mapped id whose row is gone is a user delete (tombstone).
    const liveProjects  = new Set((await q(conn, `SELECT id FROM MODBUS_ADMIN.projects`)).map((r) => Number(r.ID)));
    const liveLocations = new Set((await q(conn, `SELECT id FROM MODBUS_ADMIN.locations`)).map((r) => Number(r.ID)));

    // Legacy read-only-tree customisations (seed names/folders on first import).
    const legacyNames      = await getDatakomNodeNames().catch(() => ({}));
    const legacyContainers = await getDatakomNodeContainers().catch(() => ({}));
    const nameOf = (nodeId, fallback) => legacyNames[`dk-node-${nodeId}`] || fallback;

    // Datakom brand row (create once if missing).
    let brandId = null;
    const brandRows = await q(conn, `SELECT brand_id, brand_name FROM MODBUS_ADMIN.brands`);
    for (const b of brandRows) if (/data[ck]om/i.test(String(b.BRAND_NAME))) { brandId = Number(b.BRAND_ID); break; }
    if (brandId == null) {
      const out = await conn.execute(
        `INSERT INTO MODBUS_ADMIN.brands (brand_name) VALUES ('Datakom') RETURNING brand_id INTO :id`,
        { id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }, { autoCommit: true }
      );
      brandId = out.outBinds.id[0];
    }

    // Manual device-id allocator (DEVICES has no identity column).
    const maxRow = await q(conn, `SELECT NVL(MAX(device_id), 0) AS MAX_ID FROM MODBUS_ADMIN.DEVICES`);
    let devIdCursor = Number(maxRow[0]?.MAX_ID ?? 0);
    const nextDeviceId = () => (devIdCursor += 1);

    // Resolve (or create) the project/location for a node_key. Returns the
    // entity id, or null when tombstoned (user deleted it).
    const resolve = async (nodeKey, entityType, liveSet, create) => {
      const key = `${nodeKey}|${entityType}`;
      if (nodeMap.has(key)) {
        const id = nodeMap.get(key);
        if (liveSet.has(id)) return id;
        summary.tombstoned += 1;
        return null; // user deleted it — never resurrect
      }
      const id = await create();
      nodeMap.set(key, id);
      liveSet.add(id);
      return id;
    };

    // 1) Legacy container folders → container projects.
    const containerProjectIdByName = new Map();
    const containerNames = [...new Set(Object.values(legacyContainers).map((v) => String(v).trim()).filter(Boolean))];
    for (const cname of containerNames) {
      try {
        const id = await resolve(`folder:${cname}`, 'project', liveProjects, () =>
          createProject(conn, summary, { nodeKey: `folder:${cname}`, name: cname, brandId: null, parentId: null }));
        if (id != null) containerProjectIdByName.set(cname, id);
      } catch (e) { summary.errors.push(`folder '${cname}': ${e.message}`); }
    }

    // 2) Walk the cloud tree.
    const locationIdByNode = new Map(); // cloud node id → location id (devices attach here)

    const importRoot = async (root) => {
      const container = legacyContainers[`dk-node-${root.id}`];
      const parentProjectId = container ? (containerProjectIdByName.get(String(container).trim()) ?? null) : null;
      const projectId = await resolve(`node:${root.id}`, 'project', liveProjects, () =>
        createProject(conn, summary, { nodeKey: `node:${root.id}`, name: nameOf(root.id, root.name), brandId, parentId: parentProjectId }));
      if (projectId == null) return; // project tombstoned → skip whole subtree

      // Default location for devices sitting on the root node itself.
      const rootLocId = await resolve(`node:${root.id}`, 'location', liveLocations, () =>
        createLocation(conn, summary, { nodeKey: `node:${root.id}`, name: nameOf(root.id, root.name), projectId, parentLocationId: null }));
      if (rootLocId != null) locationIdByNode.set(root.id, rootLocId);

      const walkChildren = async (children, parentLocId) => {
        for (const child of children || []) {
          try {
            const locId = await resolve(`node:${child.id}`, 'location', liveLocations, () =>
              createLocation(conn, summary, { nodeKey: `node:${child.id}`, name: nameOf(child.id, child.name), projectId, parentLocationId: parentLocId }));
            if (locId != null) {
              locationIdByNode.set(child.id, locId);
              await walkChildren(child.children, locId);
            }
          } catch (e) { summary.errors.push(`node ${child.id} '${child.name}': ${e.message}`); }
        }
      };
      await walkChildren(root.children, rootLocId);
    };

    for (const root of tree.roots || []) {
      try { await importRoot(root); }
      catch (e) { summary.errors.push(`root ${root.id} '${root.name}': ${e.message}`); }
    }

    // 3) Ungrouped bucket (only when there are ungrouped devices).
    let ungroupedLocId = null;
    if ((tree.ungrouped || []).length) {
      try {
        const upId = await resolve('ungrouped', 'project', liveProjects, () =>
          createProject(conn, summary, { nodeKey: 'ungrouped', name: 'Datakom (Ungrouped)', brandId, parentId: null }));
        if (upId != null) {
          ungroupedLocId = await resolve('ungrouped', 'location', liveLocations, () =>
            createLocation(conn, summary, { nodeKey: 'ungrouped', name: 'Ungrouped', projectId: upId, parentLocationId: null }));
        }
      } catch (e) { summary.errors.push(`ungrouped: ${e.message}`); }
    }

    // 4) Devices.
    const allDevices = [];
    const collect = (node) => {
      for (const d of node.devices || []) allDevices.push(d);
      for (const c of node.children || []) collect(c);
    };
    for (const root of tree.roots || []) collect(root);
    for (const d of tree.ungrouped || []) allDevices.push({ ...d, node: null });

    for (const dev of allDevices) {
      const did = Number(dev.did);
      if (!Number.isFinite(did)) continue;
      try {
        if (knownDids.has(did)) {
          // Already imported (or tombstoned). Allowed update: fill missing GPS.
          const deviceId = knownDids.get(did);
          const lat = Number(dev.lat), lng = Number(dev.lng);
          if (deviceId != null && Number.isFinite(lat) && Number.isFinite(lng)) {
            const r = await conn.execute(
              `UPDATE MODBUS_ADMIN.DEVICES
                  SET latitude = :lat, longitude = :lng, gps_updated_at = SYSTIMESTAMP
                WHERE device_id = :deviceId AND latitude IS NULL AND longitude IS NULL`,
              { lat, lng, deviceId }, { autoCommit: true }
            );
            if ((r.rowsAffected || 0) > 0) summary.updatedGps += 1;
          }
          continue;
        }
        const locId = (dev.node != null ? locationIdByNode.get(dev.node) : null) ?? ungroupedLocId;
        if (locId == null) { summary.errors.push(`device did=${did}: no target location`); continue; }
        const newId = await createDevice(conn, summary, nextDeviceId, { ...dev, did }, locId, brandId);
        knownDids.set(did, newId);
      } catch (e) {
        await conn.rollback().catch(() => {});
        summary.errors.push(`device did=${did}: ${e.message}`);
      }
    }

    lastError = null;
    lastRun = { at: new Date().toISOString(), summary };
    if (summary.createdProjects || summary.createdLocations || summary.createdDevices) {
      console.log(`[DatakomSync] +${summary.createdProjects} project(s), +${summary.createdLocations} location(s), +${summary.createdDevices} device(s)` +
        (summary.errors.length ? `, ${summary.errors.length} error(s)` : ''));
      // New did-linked rows → refresh the did→device_id cache used by failover.
      if (refreshDidMapCb) await Promise.resolve(refreshDidMapCb()).catch(() => {});
    }
    return { at: lastRun.at, ...summary };
  } catch (e) {
    lastError = e.message;
    console.warn('[DatakomSync] Sync failed:', e.message);
    throw e;
  } finally {
    if (conn) await conn.close().catch(() => {});
    running = false;
  }
}

// Loop: a light tick that fires the first sync shortly after the adapter comes
// up, then re-syncs every SYNC_MS. Never overlaps (runSync self-gates).
function startSyncLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    if (!datakom.isReady() || running) return;
    const due = !lastRun || (Date.now() - Date.parse(lastRun.at)) >= SYNC_MS;
    if (due) runSync().catch(() => {});
  }, TICK_MS);
  loopTimer.unref?.();
  console.log(`[DatakomSync] Sync loop armed (every ${Math.round(SYNC_MS / 1000)}s once adapter is ready)`);
}

module.exports = { configure, runSync, getSyncStatus, startSyncLoop };
