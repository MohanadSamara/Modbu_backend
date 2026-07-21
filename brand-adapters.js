/**
 * brand-adapters.js
 *
 * The platform is multi-brand: each device row carries a brand (devices.brand_id
 * → brands.brand_name). Most brands are read over Modbus (direct TCP or via a
 * site agent — see device-io.js). A few brands expose their own cloud/portal
 * data source instead. This registry is the seam that maps a brand NAME to its
 * read-only adapter, so adding another brand later is just:
 *
 *     const acme = require('./acme-cloud');
 *     const ADAPTERS = { datakom, acme };
 *
 * An adapter is any object exposing this read-only surface:
 *     start()                     – begin/maintain the connection (idempotent)
 *     isReady()                   – true once live data is flowing
 *     getStatus()                 – connection + session diagnostics
 *     listDevices()               – devices the brand exposes, with latest reading
 *     getReading(idOrName)        – one device's latest reading
 *
 * Adapters are READ-ONLY. Control (start/stop) stays on the Modbus/agent path the
 * platform owns — it is never routed through a brand adapter.
 */

const datakom = require('./datakom-rainbow');

// Keyed by lower-cased brand name (matches brands.brand_name, case-insensitively).
const ADAPTERS = {
  datakom,
};

// Alternate brand spellings that map to the same adapter. "Datacom" is a common
// variant of "Datakom" and users create the brand under either name — both must
// resolve to the Datakom Rainbow cloud data source.
const ALIASES = {
  datacom: 'datakom',
};

// Resolve the adapter for a brand name, or null when the brand has no special
// data source (i.e. it is read over Modbus like everything else).
function getAdapter(brand) {
  if (!brand) return null;
  const key = String(brand).trim().toLowerCase();
  return ADAPTERS[key] || ADAPTERS[ALIASES[key]] || null;
}

// Start every configured adapter. Each self-gates on its own env config, so this
// is a no-op for brands whose credentials aren't set.
function startAll() {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      adapter.start?.();
    } catch (e) {
      console.warn(`[BrandAdapters] '${name}' failed to start: ${e.message}`);
    }
  }
}

module.exports = { getAdapter, startAll, ADAPTERS };
