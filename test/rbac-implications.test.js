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

test('every implication references only built-in permission keys', () => {
  for (const [strong, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
    assert.ok(BUILTIN_PERMISSION_KEYS.includes(strong), `${strong} is not a built-in key`);
    for (const k of implied) {
      assert.ok(BUILTIN_PERMISSION_KEYS.includes(k), `${k} (implied by ${strong}) is not a built-in key`);
    }
  }
});
