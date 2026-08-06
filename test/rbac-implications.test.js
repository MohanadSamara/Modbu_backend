// Permission implication expansion (write implies read, etc.) — the map that
// keeps a single granted permission usable on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keysSatisfying, PERMISSION_IMPLICATIONS, BUILTIN_PERMISSION_KEYS } = require('../rbac-defaults');

test('device.read is satisfied by every stronger device permission', () => {
  const keys = keysSatisfying('device.read');
  for (const k of ['device.read', 'device.write', 'device.connect', 'device.control', 'device.start', 'device.stop']) {
    assert.ok(keys.includes(k), `${k} should satisfy device.read`);
  }
});

test('write keys imply their read key', () => {
  for (const resource of ['project', 'location', 'settings', 'user', 'datakom']) {
    assert.ok(
      keysSatisfying(`${resource}.read`).includes(`${resource}.write`),
      `${resource}.write should satisfy ${resource}.read`
    );
  }
});

test('a strong key is not satisfied by a weak one', () => {
  assert.deepEqual(keysSatisfying('device.write'), ['device.write']);
  assert.deepEqual(keysSatisfying('user.assign_role'), ['user.assign_role']);
});

test('fuel.read is satisfied by device.control', () => {
  assert.ok(keysSatisfying('fuel.read').includes('device.control'));
});

test('datakom.read is independent of device.read (Datakom Cloud is controllable on its own)', () => {
  const keys = keysSatisfying('datakom.read');
  assert.ok(!keys.includes('device.read'), 'device.read must NOT satisfy datakom.read — Datakom Cloud access has to be grantable/revocable without touching device access');
  assert.ok(!keys.includes('device.write'), 'device.write must NOT satisfy datakom.read');
  // datakom.write still implies its own read, and needs device.read to link/unlink devices.
  assert.ok(keysSatisfying('datakom.read').includes('datakom.write'), 'datakom.write should satisfy datakom.read');
  assert.ok(keysSatisfying('device.read').includes('datakom.write'), 'datakom.write should satisfy device.read (needs to see devices to link them)');
});

test('fuel.read is satisfied by device.read', () => {
  assert.ok(keysSatisfying('fuel.read').includes('device.read'));
});

test('a datakom-only viewer can read fuel (datakom.read implies fuel.read)', () => {
  const keys = keysSatisfying('fuel.read');
  assert.ok(keys.includes('datakom.read'));
  // and transitively datakom.write → datakom.read → fuel.read
  assert.ok(keys.includes('datakom.write'));
});

test('every implication references only built-in permission keys', () => {
  for (const [strong, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
    assert.ok(BUILTIN_PERMISSION_KEYS.includes(strong), `${strong} is not a built-in key`);
    for (const k of implied) {
      assert.ok(BUILTIN_PERMISSION_KEYS.includes(k), `${k} (implied by ${strong}) is not a built-in key`);
    }
  }
});
