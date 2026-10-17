// Webhook relay, runs INSIDE the run VM at REAL time (never under libfaketime).
// Verifies Stripe's real signature, then re-signs the byte-identical body at the app's simulated time,
// forwards it to the app and returns the app's real status to Stripe. Logs every delivery as a JSON line.
// Env: WHSEC, APP_URL (http://127.0.0.1:3000), OFFSET_FILE (/run/m/offset), LOG_FILE, PORT (8787).
const http = require('http'), crypto = require('crypto'), fs = require('fs')
const { WHSEC, APP_URL = 'http://127.0.0.1:3000', OFFSET_FILE = '/run/m/offset', LOG_FILE = '/run/m/deliveries.log' } = process.env
const hmac = (t, body) => crypto.createHmac('sha256', WHSEC).update(`${t}.`).update(body).digest('hex')
const offset = () => parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0
const HOP = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(200); return res.end('mannequin relay') } // health check, not a delivery
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks), now = Math.floor(Date.now() / 1000)
    const sig = Object.fromEntries((req.headers['stripe-signature'] || '').split(',').map((kv) => kv.split('=')))
    const want = Buffer.from(hmac(sig.t, body)), got = Buffer.from(sig.v1 || '')
    let ev = {}
    try { ev = JSON.parse(body) } catch {}
    const log = (status) => fs.appendFileSync(LOG_FILE, JSON.stringify({ at: now, id: ev.id, type: ev.type, status }) + '\n')
    if (!sig.t || got.length !== want.length || !crypto.timingSafeEqual(want, got) || Math.abs(now - sig.t) > 300) {
      log(400); res.writeHead(400); return res.end('bad signature')
    }
    const t = now + offset() // the app's "now"
    const headers = { ...req.headers, 'stripe-signature': `t=${t},v1=${hmac(t, body)}` }
    for (const k of HOP) delete headers[k]
    try {
      const r = await fetch(APP_URL + req.url, { method: 'POST', headers, body })
      log(r.status); res.writeHead(r.status); res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) {
      log(502); res.writeHead(502); res.end(String(e))
    }
  })
}).listen(process.env.PORT || 8787, '0.0.0.0')
