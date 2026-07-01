/**
 * test-login-api.js — hit POST /api/auth/login directly to see exactly
 * what the server returns. Bypasses the frontend entirely.
 *
 * Make sure the server is running (`npm start`) before running this.
 *
 * Usage:
 *   node test-login-api.js                       (uses defaults)
 *   node test-login-api.js admin YourNewPassword (custom values)
 */

const USERNAME = process.argv[2] || 'admin';
const PASSWORD = process.argv[3] || 'YourNewPassword';
const URL      = 'http://localhost:3000/api/auth/login';

(async () => {
  console.log(`POST ${URL}`);
  console.log(`  body: { login: "${USERNAME}", password: "${PASSWORD}" }\n`);

  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: USERNAME, password: PASSWORD }),
    });
  } catch (err) {
    console.error('❌ Request failed at the network level:', err.message);
    console.error('   Is the server running? Try: npm start');
    process.exit(1);
  }

  console.log(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  console.log('Response body:');
  console.log(body);

  if (res.ok) {
    console.log('\n✓ Login succeeded at the API level.');
    console.log('  If the frontend still says "Login failed", the issue is');
    console.log('  client-side (network tab in DevTools will show why).');
  } else {
    console.log('\n❌ The server rejected the login.');
    console.log('  Look at the server console output to see the matching');
    console.log('  log line that corresponds to this request.');
  }
})();
