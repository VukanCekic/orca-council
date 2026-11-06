// Shared Council file readers. These helpers only inspect files and process liveness.
import fs from 'node:fs'

export function readText(p, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > maxBytes) return null
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch { return null }
}

export function readJson(p) {
  const t = readText(p)
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}

// Signal 0 only checks whether a process exists; it sends no signal.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}
