'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeConsumption, bucketEvents, describeAlarm } = require('../lib/telemetry-math');

const HOUR = 3_600_000;

test('computeConsumption: returns null with too few samples', () => {
  assert.equal(computeConsumption([]), null);
  assert.equal(computeConsumption([{ v: 50, t: 0 }]), null);
});

test('computeConsumption: positive rate when fuel is dropping', () => {
  const t0 = Date.now();
  // 100% → 90% over 2 hours = 5%/h consumption.
  const r = computeConsumption([
    { v: 100, t: t0 },
    { v: 95,  t: t0 + HOUR },
    { v: 90,  t: t0 + 2 * HOUR },
  ]);
  assert.ok(r);
  assert.equal(r.ratePerHour, 5);
  assert.equal(r.samples, 3);
  assert.equal(r.firstValue, 100);
  assert.equal(r.lastValue, 90);
});

test('computeConsumption: negative rate when refuelling', () => {
  const t0 = Date.now();
  const r = computeConsumption([
    { v: 40, t: t0 },
    { v: 60, t: t0 + 2 * HOUR }, // +20% over 2h ⇒ -10%/h (filling, not burning)
  ]);
  assert.equal(r.ratePerHour, -10);
});

test('computeConsumption: null when time span is zero', () => {
  const t0 = Date.now();
  assert.equal(computeConsumption([{ v: 90, t: t0 }, { v: 80, t: t0 }]), null);
});

test('computeConsumption: ignores non-finite samples', () => {
  const t0 = Date.now();
  const r = computeConsumption([
    { v: 'nope', t: t0 },
    { v: 100, t: t0 },
    { v: 90,  t: t0 + HOUR },
  ]);
  assert.ok(r);
  assert.equal(r.samples, 2);
  assert.equal(r.ratePerHour, 10);
});

test('bucketEvents: counts events into the right buckets', () => {
  const now = 24 * HOUR; // fixed clock so buckets are deterministic
  const spanMs = 24 * HOUR;
  const buckets = 24; // 1 bucket per hour
  const events = [
    { t: now - 0.5 * HOUR, kind: 'packet' }, // last bucket
    { t: now - 0.5 * HOUR, kind: 'error' },  // last bucket
    { t: now - 23.5 * HOUR, kind: 'packet' }, // first bucket
    { t: now - 100 * HOUR, kind: 'packet' },  // out of range → ignored
  ];
  const series = bucketEvents(events, { now, spanMs, buckets, errorKind: 'error' });
  assert.equal(series.length, 24);
  assert.equal(series[0].total, 1);   // first bucket
  assert.equal(series[23].total, 2);  // last bucket (packet + error)
  assert.equal(series[23].errors, 1);
  // Totals across buckets exclude the out-of-range event.
  const total = series.reduce((s, b) => s + b.total, 0);
  assert.equal(total, 3);
});

test('bucketEvents: upper-edge event lands in the last bucket', () => {
  const now = 12 * HOUR;
  const series = bucketEvents([{ t: now, kind: 'packet' }], {
    now, spanMs: 12 * HOUR, buckets: 12, errorKind: 'error',
  });
  assert.equal(series[series.length - 1].total, 1);
});

test('describeAlarm: known + unknown types', () => {
  assert.deepEqual(describeAlarm('ALARM_CRITICAL_FUEL'), { message: 'Fuel critically low', severity: 'critical' });
  assert.deepEqual(describeAlarm('ALARM_LOW_FUEL'), { message: 'Fuel low', severity: 'warning' });
  assert.equal(describeAlarm('SOMETHING_ELSE').severity, 'info');
});
