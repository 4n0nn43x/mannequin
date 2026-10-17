// "My runs": the runs started from this browser, kept in localStorage only (no account, nothing on the server).
export type MyRun = { id: string; repo: string; at: number; verdict?: string; leaks?: number }
const KEY = 'mq-runs'

export function myRuns(): MyRun[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function saveRun(r: MyRun) {
  try { localStorage.setItem(KEY, JSON.stringify([r, ...myRuns().filter((x) => x.id !== r.id)].slice(0, 50))) } catch {}
}

export function clearRuns() {
  try { localStorage.removeItem(KEY) } catch {}
}
