import { startRun } from '@/lib/runs'

export const runtime = 'nodejs'

const bad = (error: string) => Response.json({ error }, { status: 400 })

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { repo?: unknown; stripeKey?: unknown; route?: unknown } | null
  const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
  const key = typeof body?.stripeKey === 'string' ? body.stripeKey.trim() : ''
  const route = typeof body?.route === 'string' && body.route.trim() ? body.route.trim() : undefined

  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(repo)) return bad('Repo must be a public GitHub URL like https://github.com/owner/name')
  if (/^(sk|rk)_live_/.test(key)) return bad('Live keys are refused. Use a Stripe TEST key (sk_test_... or rk_test_...).')
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return bad('Stripe key must be a test key (sk_test_... or rk_test_...).')
  // the route ends up in a shell command inside the VM: plain path characters only
  if (route && !/^\/[\w\-/]*$/.test(route)) return bad('Probe route must be a plain path like /dashboard/billing')

  return Response.json({ id: startRun({ repo: repo.replace(/\/$/, ''), stripeKey: key, route }) })
}
