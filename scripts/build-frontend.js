// Builds the React frontend (a sibling repo, not nested under this one) and
// copies its output into deploy/www, so the backend's static-file fallback
// (see index.js's "Hosted frontend" block) serves it from the same origin as
// the API — no separate frontend host, no cross-origin CORS/WS config needed.
// Run before every deploy where the frontend has changed: `npm run build:frontend`.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRONTEND_SOURCE = path.resolve(__dirname, '..', '..', 'FrontEndModbus', 'Modbus-front');
const FRONTEND_DIST   = path.join(FRONTEND_SOURCE, 'dist');
const DEPLOY_WWW       = path.resolve(__dirname, '..', 'deploy', 'www');

if (!fs.existsSync(FRONTEND_SOURCE)) {
  console.error(`Frontend source not found at ${FRONTEND_SOURCE}`);
  process.exit(1);
}

console.log(`[build-frontend] Building ${FRONTEND_SOURCE} ...`);
execSync('npm run build', { cwd: FRONTEND_SOURCE, stdio: 'inherit' });

console.log(`[build-frontend] Copying ${FRONTEND_DIST} -> ${DEPLOY_WWW}`);
fs.rmSync(DEPLOY_WWW, { recursive: true, force: true });
fs.cpSync(FRONTEND_DIST, DEPLOY_WWW, { recursive: true });

console.log('[build-frontend] Done.');
