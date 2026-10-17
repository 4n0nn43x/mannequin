// Forge a next-auth (v4, JWT strategy) session cookie for taxonomy.
// Usage (from /root/app): node session.js <email>   -> prints the value for cookie next-auth.session-token
// The user must exist in `users`: taxonomy's jwt callback looks it up by token.email.
const fs = require("fs")
const path = require("path")
const email = process.argv[2]
if (!email) { console.error("usage: node session.js <email>"); process.exit(1) }
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const { encode } = require(path.join(process.cwd(), "node_modules/next-auth/jwt"))
encode({ token: { email, name: email }, secret: process.env.NEXTAUTH_SECRET })
  .then((t) => console.log(t))
