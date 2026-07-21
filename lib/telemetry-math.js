/**
 * lib/telemetry-math.js
 *
 * PURE MODULE — no DB, no Modbus, no I/O. Just number-crunching used by the
 * consumption/alarm path and the stats endpoint. Kept dependency-free so it can
 * be unit-tested in isolation and reused on both the server and (potentially)
 * the agent without dragging Oracle/Modbus into the require graph.
 */

/**
 * Compute a fuel-consumption rate (%/hour) from an ordered list of samples.
 *
 * @param {Array<{v:number,t:number}>} samples  fuel% value + epoch-ms time,
 *        sorted oldest→newest. (v = fuel percent, t = Date.now()-style ms.)
 * @param {number} minSamples  minimum samples required (default 2).
 * @returns {null | {
 *   ratePerHour:number, samples:number,
 *   firstValue:number, lastValue:number, firstTime:string, lastTime:string
 * }}  positive ratePerHour = fuel decreasing (burning). null if not enough data
 *     or a zero/negative time span.
 */
function computeConsumption(samples, minSamples = 2) {
  const clean = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ v: Number(s.v), t: Number(s.t) }))
    .filter((s) => Number.isFinite(s.v) && Number.isFinite(s.t));

  if (clean.length < minSamples) return null;

  const first = clean[0];
  const last  = clean[clean.length - 1];
  const dtHours = (last.t - first.t) / 3_600_000;
  if (dtHours <= 0) return null;

  // Negative slope on fuel% over time = consumption. Report the magnitude.
  const slopePerHour = (last.v - first.v) / dtHours;
  const consumption  = -slopePerHour;

  return {
    ratePerHour: Number(consumption.toFixed(3)),
    samples:     clean.length,
    firstValue:  first.v,
    lastValue:   last.v,
    firstTime:   new Date(first.t).toISOString(),
    lastTime:    new Date(last.t).toISOString(),
  };
}

/**
 * Bucket time-stamped events into fixed-width time windows and count them.
 * Used to turn raw device_readings / device_actions rows into the packet/error
 * series the dashboard charts expect.
 *
 * @param {Array<{t:number, kind?:string}>} events  epoch-ms + optional kind.
 * @param {object} opts
 * @param {number} opts.now        window end, epoch-ms (default Date.now()).
 * @param {number} opts.spanMs     total span to cover, ms (default 24h).
 * @param {number} opts.buckets    number of buckets across the span (default 24).
 * @param {string} opts.errorKind  kind counted as an "error" (default 'error').
 * @returns {Array<{timestamp:string, total:number, errors:number}>}  oldest→newest.
 */
function bucketEvents(events, opts = {}) {
  const now       = Number.isFinite(opts.now) ? opts.now : Date.now();
  const spanMs    = Number.isFinite(opts.spanMs) ? opts.spanMs : 24 * 60 * 60 * 1000;
  const buckets   = Number.isInteger(opts.buckets) && opts.buckets > 0 ? opts.buckets : 24;
  const errorKind = opts.errorKind ?? 'error';

  const start   = now - spanMs;
  const width   = spanMs / buckets;
  const series  = Array.from({ length: buckets }, (_, i) => ({
    // Timestamp marks the END of each bucket.
    timestamp: new Date(start + width * (i + 1)).toISOString(),
    total: 0,
    errors: 0,
  }));

  for (const ev of Array.isArray(events) ? events : []) {
    const t = Number(ev.t);
    if (!Number.isFinite(t) || t < start || t > now) continue;
    let idx = Math.floor((t - start) / width);
    if (idx >= buckets) idx = buckets - 1; // include the exact upper edge
    if (idx < 0) continue;
    series[idx].total += 1;
    if (ev.kind === errorKind) series[idx].errors += 1;
  }

  return series;
}

/**
 * Map a Modbus alarm action_type to a human-readable message + severity.
 * Single source of truth so the /alarms and /alarms/live endpoints agree.
 */
function describeAlarm(actionType) {
  switch (actionType) {
    case 'ALARM_CRITICAL_FUEL':    return { message: 'Fuel critically low',   severity: 'critical' };
    case 'ALARM_LOW_FUEL':         return { message: 'Fuel low',              severity: 'warning'  };
    case 'ALARM_HIGH_CONSUMPTION': return { message: 'High consumption rate', severity: 'warning'  };
    default:                       return { message: actionType,             severity: 'info'     };
  }
}

module.exports = { computeConsumption, bucketEvents, describeAlarm };
