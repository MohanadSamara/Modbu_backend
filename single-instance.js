/**
 * single-instance.js
 *
 * Prevents a second backend process from starting while one is already running.
 *
 * Why this exists: the Datakom Rainbow portal allows only ONE session per
 * account, so two concurrent backend instances log in and repeatedly kick each
 * other, leaving the cloud connection stuck in a reconnect loop with no live
 * data. A port bind alone does not reliably catch this — under a startup race
 * both processes can end up running — so we add an explicit PID lockfile.
 *
 * Mechanism: an exclusive-create lockfile holding the owner PID. If the file
 * already exists we check whether that PID is still alive; a stale lock (owner
 * gone, e.g. after a crash) is reclaimed, a live one blocks startup.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-port lock: different ports are legitimately different services, so key the
// lock on the port to avoid a dev instance on another port blocking production.
function lockFilePath(port) {
  return path.join(os.tmpdir(), `modbus-backend-${port}.lock`);
}

// True if a process with this PID is currently running. process.kill(pid, 0)
// sends no signal — it only probes existence. ESRCH = gone; EPERM = alive but
// owned by another user (still counts as running).
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Acquire the single-instance lock for the given port.
 * @returns {{ ok: true, file: string } | { ok: false, file: string, holderPid: number|null }}
 */
function acquire(port) {
  const file = lockFilePath(port);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' fails with EEXIST if the file already exists — the atomic gate.
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true, file };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Someone holds the lock. Reclaim it only if that owner is gone (stale).
      const holderPid = readHolderPid(file);
      if (holderPid != null && isProcessAlive(holderPid)) {
        return { ok: false, file, holderPid };
      }
      // Stale (or unreadable) lock — remove and retry once.
      try { fs.unlinkSync(file); } catch (_) { /* another starter won the race */ }
    }
  }

  // Lost a reclaim race with a concurrent starter that took the lock first.
  return { ok: false, file, holderPid: readHolderPid(file) };
}

function readHolderPid(file) {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (_) {
    return null;
  }
}

// Release the lock, but only if we still own it — never delete a lock a later
// instance legitimately took over.
function release(port) {
  const file = lockFilePath(port);
  if (readHolderPid(file) === process.pid) {
    try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
  }
}

module.exports = { acquire, release, lockFilePath };
