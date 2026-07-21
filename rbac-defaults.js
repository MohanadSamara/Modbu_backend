// ============================================================================
// rbac-defaults.js — canonical default RBAC seed data (single source of truth).
//
// Used by db.js to:
//   • seed MODBUS_ADMIN.ui_element_catalog at startup (so the Permissions editor
//     shows the full catalog instead of the frontend's small static fallback)
//   • power the "Restore defaults" reset actions on the Permissions & Roles pages
//
// Keep this in sync with the built-in guards in routes-users.js and the frontend
// catalog in FrontEndModbus/.../config/uiElements.js.
// ============================================================================

// ── Built-in permission keys ────────────────────────────────────────────────
// Mirrors the seed data in the (now-removed) schema.sql and the guards used by
// the backend routes. These can be re-described but never renamed/deleted.
const BUILTIN_PERMISSIONS = [
  { key: 'device.read',      description: 'View devices',               resource: 'device',   level: 'read' },
  { key: 'device.write',     description: 'Create/edit devices',        resource: 'device',   level: 'write' },
  { key: 'device.connect',   description: 'Connect to a device',        resource: 'device',   level: 'connect' },
  { key: 'device.control',   description: 'Send commands to device',    resource: 'device',   level: 'control' },
  { key: 'device.start',     description: 'Start a device',             resource: 'device',   level: 'start' },
  { key: 'device.stop',      description: 'Stop a device',              resource: 'device',   level: 'stop' },
  { key: 'fuel.read',        description: 'View fuel readings',         resource: 'fuel',     level: 'read' },
  { key: 'alarm.read',       description: 'View alarms',                resource: 'alarm',    level: 'read' },
  { key: 'project.read',     description: 'View projects',              resource: 'project',  level: 'read' },
  { key: 'project.write',    description: 'Create/edit projects',       resource: 'project',  level: 'write' },
  { key: 'location.read',    description: 'View locations',             resource: 'location', level: 'read' },
  { key: 'location.write',   description: 'Create/edit locations',      resource: 'location', level: 'write' },
  { key: 'settings.read',    description: 'View settings',              resource: 'settings', level: 'read' },
  { key: 'settings.write',   description: 'Edit settings',              resource: 'settings', level: 'write' },
  { key: 'user.read',        description: 'View users & roles',         resource: 'user',     level: 'read' },
  { key: 'user.write',       description: 'Create/edit users',          resource: 'user',     level: 'write' },
  { key: 'user.assign_role', description: 'Assign roles & permissions', resource: 'user',     level: 'assign_role' },
  { key: 'audit.read',       description: 'View audit log',             resource: 'audit',    level: 'read' },
  { key: 'datakom.read',     description: 'View live Datakom Rainbow data', resource: 'datakom', level: 'read' },
  { key: 'datakom.write',    description: 'Link / unlink Datakom devices',  resource: 'datakom', level: 'write' },
];

// ── Built-in system roles + the permission keys each one holds ───────────────
// `permissions`: 'ALL' = every built-in, 'ALL_READ' = every read-level built-in,
// or an explicit list of permission keys.
const SYSTEM_ROLES = [
  {
    key: 'admin', name: 'Administrator', description: 'Full system access',
    scopeLevel: 'global', permissions: 'ALL',
  },
  {
    key: 'viewer', name: 'Viewer', description: 'Read-only access',
    scopeLevel: 'global', permissions: 'ALL_READ',
  },
  {
    key: 'operator', name: 'Operator', description: 'Device connect/control access',
    scopeLevel: 'global',
    permissions: [
      'device.read', 'device.connect', 'device.control', 'device.start', 'device.stop',
      'fuel.read', 'alarm.read', 'project.read', 'location.read', 'settings.read',
    ],
  },
];

// ── Permission implications ─────────────────────────────────────────────────
// A stronger permission automatically includes the weaker ones it needs to be
// usable. Without this, granting e.g. device.write alone produces a broken
// experience (can edit devices but not list them). Checks for a key on the
// RIGHT side are satisfied by holding any key on the LEFT side, at the same
// scope as the grant. Kept in sync with the frontend copy in
// FrontEndModbus/.../src/config/uiElements.js (PERMISSION_IMPLICATIONS).
const PERMISSION_IMPLICATIONS = {
  // Viewing a device includes viewing its live data, whatever the transport —
  // datakom.read is NOT a separate parallel permission to hand out; it exists
  // only to grant cloud-data access on its own, without full device access.
  'device.read':      ['datakom.read', 'fuel.read'],
  'device.write':     ['device.read'],
  'device.connect':   ['device.read'],
  'device.control':   ['device.read', 'fuel.read'],
  'device.start':     ['device.read'],
  'device.stop':      ['device.read'],
  'fuel.read':        [],
  // Live Datakom data includes the fuel level — a datakom-only viewer must
  // not see devices with empty gauges.
  'datakom.read':     ['fuel.read'],
  'project.write':    ['project.read'],
  'location.write':   ['location.read'],
  'settings.write':   ['settings.read'],
  'user.write':       ['user.read'],
  'user.assign_role': ['user.read'],
  'datakom.write':    ['datakom.read', 'device.read'],
};

// All permission keys that satisfy a check for `key` (the key itself plus any
// stronger keys that imply it, transitively — device.write → device.read →
// datakom.read means device.write also satisfies datakom.read).
function keysSatisfying(key) {
  const out = new Set([key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [strong, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
      if (!out.has(strong) && implied.some((k) => out.has(k))) {
        out.add(strong);
        grew = true;
      }
    }
  }
  return [...out];
}

// Resolve a role's `permissions` field into a concrete list of permission keys.
function permissionKeysForRole(role) {
  if (role.permissions === 'ALL')      return BUILTIN_PERMISSIONS.map((p) => p.key);
  if (role.permissions === 'ALL_READ') return BUILTIN_PERMISSIONS.filter((p) => p.level === 'read').map((p) => p.key);
  return Array.isArray(role.permissions) ? role.permissions : [];
}

// ── Full UI element catalog (buttons/controls), grouped by field ─────────────
// `field` is the resource area the element belongs to (used to group it in the
// Permissions editor). Transcribed from UI-ELEMENTS-SUMMARY.md.
const UI_ELEMENT_CATALOG = [
  // Authentication
  { id: 'auth.login',            field: 'auth',       label: 'Login form',                     sortOrder: 1 },
  { id: 'auth.logout',           field: 'auth',       label: 'Logout button',                  sortOrder: 2 },
  { id: 'auth.change_password',  field: 'auth',       label: 'Change own password',            sortOrder: 3 },

  // Alarms
  { id: 'alarm.mute',            field: 'alarm',      label: 'Mute alarm sound button',        sortOrder: 10 },
  { id: 'alarm.acknowledge',     field: 'alarm',      label: 'Acknowledge alarm',              sortOrder: 11 },
  { id: 'alarm.reset',           field: 'alarm',      label: 'Reset / clear active alarm',     sortOrder: 12 },
  { id: 'alarm.view_events',     field: 'alarm',      label: 'View events / alarms log',       sortOrder: 13 },
  { id: 'alarm.read',            field: 'alarm',      label: 'View alarms',                    sortOrder: 14 },
  { id: 'alarm.snooze',          field: 'alarm',      label: 'Snooze alarm button',            sortOrder: 15 },
  { id: 'alarm.accept',          field: 'alarm',      label: 'Accept alarm',                   sortOrder: 16 },

  // Devices
  { id: 'device.read',           field: 'device',     label: 'View device details / status',   sortOrder: 20 },
  { id: 'device.write',          field: 'device',     label: 'Modify device settings',         sortOrder: 21 },
  { id: 'device.connect',        field: 'device',     label: 'Connect / Disconnect button',    sortOrder: 22 },
  { id: 'device.start',          field: 'device',     label: 'Start device button',            sortOrder: 23 },
  { id: 'device.stop',           field: 'device',     label: 'Stop device button',             sortOrder: 24 },
  { id: 'device.start_stop',     field: 'device',     label: 'Start / Stop controls',          sortOrder: 25 },
  { id: 'device.control',        field: 'device',     label: 'Control device operations',      sortOrder: 26 },
  { id: 'device.add',            field: 'device',     label: 'Add device button',              sortOrder: 27 },
  { id: 'device.edit',           field: 'device',     label: 'Edit device configuration',      sortOrder: 28 },
  { id: 'device.delete',         field: 'device',     label: 'Delete device button',           sortOrder: 29 },

  // Projects
  { id: 'project.read',          field: 'project',    label: 'View projects',                  sortOrder: 30 },
  { id: 'project.write',         field: 'project',    label: 'Modify projects',                sortOrder: 31 },
  { id: 'project.create',        field: 'project',    label: 'Create project / location',      sortOrder: 32 },
  { id: 'project.rename',        field: 'project',    label: 'Rename project / location',      sortOrder: 33 },
  { id: 'project.edit',          field: 'project',    label: 'Edit project details',           sortOrder: 34 },
  { id: 'project.delete',        field: 'project',    label: 'Delete project / location',      sortOrder: 35 },

  // Locations
  { id: 'location.read',         field: 'location',   label: 'View locations',                 sortOrder: 36 },
  { id: 'location.write',        field: 'location',   label: 'Create / edit / delete locations', sortOrder: 37 },
  { id: 'location.create',       field: 'location',   label: 'Create location button',         sortOrder: 38 },
  { id: 'location.edit',         field: 'location',   label: 'Edit location button',           sortOrder: 39 },
  { id: 'location.rename',       field: 'location',   label: 'Rename location',                sortOrder: 40 },
  { id: 'location.delete',       field: 'location',   label: 'Delete location button',         sortOrder: 41 },
  { id: 'location.move',         field: 'location',   label: 'Move location to another project', sortOrder: 42 },

  // Settings
  { id: 'settings.read',         field: 'settings',   label: 'View settings',                  sortOrder: 43 },
  { id: 'settings.write',        field: 'settings',   label: 'Modify settings',                sortOrder: 44 },
  { id: 'settings.edit',         field: 'settings',   label: 'Edit settings button',           sortOrder: 45 },
  { id: 'settings.reset',        field: 'settings',   label: 'Reset settings to default',      sortOrder: 46 },
  { id: 'settings.device',       field: 'settings',   label: 'Device-specific settings',       sortOrder: 47 },

  // Fuel monitoring
  { id: 'fuel.read',             field: 'fuel',       label: 'Read fuel levels',               sortOrder: 48 },
  { id: 'fuel.view_history',     field: 'fuel',       label: 'View fuel history charts',        sortOrder: 49 },
  { id: 'fuel.view_stats',       field: 'fuel',       label: 'View fuel statistics',           sortOrder: 50 },

  // Users
  { id: 'user.read',             field: 'user',       label: 'View users',                     sortOrder: 51 },
  { id: 'user.write',            field: 'user',       label: 'Create / edit / delete users',   sortOrder: 52 },
  { id: 'user.create',           field: 'user',       label: 'Create user button',             sortOrder: 53 },
  { id: 'user.edit',             field: 'user',       label: 'Edit user details',              sortOrder: 54 },
  { id: 'user.delete',           field: 'user',       label: 'Delete user',                    sortOrder: 55 },
  { id: 'user.lock',             field: 'user',       label: 'Lock / unlock user',             sortOrder: 56 },
  { id: 'user.reset_password',   field: 'user',       label: 'Reset user password',            sortOrder: 57 },
  { id: 'user.assign_role',      field: 'user',       label: 'Assign role button',             sortOrder: 58 },

  // Roles
  { id: 'role.read',             field: 'role',       label: 'View roles',                     sortOrder: 59 },
  { id: 'role.write',            field: 'role',       label: 'Create / edit / delete roles',   sortOrder: 60 },
  { id: 'role.create',           field: 'role',       label: 'Create role button',             sortOrder: 61 },
  { id: 'role.edit',             field: 'role',       label: 'Edit role details',              sortOrder: 62 },
  { id: 'role.delete',           field: 'role',       label: 'Delete role button',             sortOrder: 63 },

  // Permissions
  { id: 'permission.read',       field: 'permission', label: 'View permissions',               sortOrder: 64 },
  { id: 'permission.write',      field: 'permission', label: 'Manage permissions',             sortOrder: 65 },
  { id: 'permission.assign',     field: 'permission', label: 'Assign permissions to roles',    sortOrder: 66 },

  // Audit
  { id: 'audit.read',            field: 'audit',      label: 'View audit log',                 sortOrder: 70 },
  { id: 'audit.view',            field: 'audit',      label: 'View audit log (detailed)',      sortOrder: 71 },
  { id: 'audit.export',          field: 'audit',      label: 'Export audit log',               sortOrder: 72 },

  // Brands
  { id: 'brand.read',            field: 'brand',      label: 'View device brands',             sortOrder: 80 },
  { id: 'brand.write',           field: 'brand',      label: 'Create / edit / delete brands',  sortOrder: 81 },
  { id: 'brand.create',          field: 'brand',      label: 'Create brand button',            sortOrder: 82 },
  { id: 'brand.edit',            field: 'brand',      label: 'Edit brand button',              sortOrder: 83 },
  { id: 'brand.delete',          field: 'brand',      label: 'Delete brand button',            sortOrder: 84 },

  // Telemetry / monitoring
  { id: 'telemetry.read',        field: 'telemetry',  label: 'View telemetry data',            sortOrder: 90 },
  { id: 'telemetry.live',        field: 'telemetry',  label: 'View live telemetry updates',    sortOrder: 91 },
  { id: 'gps.read',              field: 'gps',        label: 'Read GPS position',              sortOrder: 92 },
  { id: 'registers.read',        field: 'registers',  label: 'Read Modbus registers',          sortOrder: 93 },
  { id: 'events.read',           field: 'events',     label: 'View events log',                sortOrder: 94 },
  { id: 'events.view',           field: 'events',     label: 'View event details',             sortOrder: 95 },

  // Datakom Rainbow (cloud live view + device linking)
  { id: 'datakom.read',          field: 'datakom',    label: 'Live — Datakom Rainbow view',    sortOrder: 96 },
  { id: 'datakom.link',          field: 'datakom',    label: 'Link device to Datakom Rainbow', sortOrder: 97 },
  { id: 'datakom.unlink',        field: 'datakom',    label: 'Unlink Datakom device',          sortOrder: 98 },
];

// ── Default permission → UI element mappings ─────────────────────────────────
// Each built-in permission covers the catalog elements in its own field. The
// permission's access level then decides usable (write/control/…) vs view-only
// (read) on the client — so device.read and device.write can both cover the
// device.* elements without conflict. user.assign_role additionally governs the
// role.* and permission.* management controls.
function defaultElementMappings() {
  const byField = {};
  for (const el of UI_ELEMENT_CATALOG) (byField[el.field] ||= []).push(el.id);

  const maps = [];
  const seen = new Set();
  const add = (permissionKey, elementId) => {
    const k = `${permissionKey}|${elementId}`;
    if (seen.has(k)) return;
    seen.add(k);
    maps.push({ permissionKey, elementId });
  };

  for (const p of BUILTIN_PERMISSIONS) {
    for (const elId of byField[p.resource] || []) add(p.key, elId);
  }
  // Role & permission administration is gated by user.assign_role.
  for (const elId of [...(byField.role || []), ...(byField.permission || [])]) {
    add('user.assign_role', elId);
  }
  return maps;
}

module.exports = {
  BUILTIN_PERMISSIONS,
  BUILTIN_PERMISSION_KEYS: BUILTIN_PERMISSIONS.map((p) => p.key),
  SYSTEM_ROLES,
  UI_ELEMENT_CATALOG,
  PERMISSION_IMPLICATIONS,
  keysSatisfying,
  permissionKeysForRole,
  defaultElementMappings,
};
