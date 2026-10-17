// CreateOS Sandbox: one paused snapshot per repo@commit, one fork per run.
import { createClient, type Sandbox } from '@nodeops-createos/sandbox'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SHAPE = 's-2vcpu-4gb'
export const FAKETIME =
  'LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 FAKETIME_TIMESTAMP_FILE=/run/m/offset ' +
  'FAKETIME_NO_CACHE=1 FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME_DISABLE_SHM=1'

export function secret(env: string, file: string): string {
  const v = process.env[env] ?? (() => { try { return readFileSync(join(homedir(), file), 'utf8').trim() } catch { return '' } })()
  if (!v) throw new Error(`missing ${env} (or ~/${file})`)
  return v
}

export const createos = () =>
  createClient({
    apiKey: process.env.CREATEOS_SANDBOX_API_KEY ?? process.env.CREATEOS_PROJECT_API_KEY ?? secret('CREATEOS_API_KEY', '.createos_key'),
    baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL ?? 'https://api-eu.sb.createos.sh', // mandatory for the event
  })

export type Exec = { code: number; out: string }

/** Run a bash script in the VM; never throws on a non-zero exit (the agent needs to see failures). */
export async function sh(vm: Sandbox, script: string, timeoutMs = 600_000): Promise<Exec> {
  const { result } = await vm.runCommand('bash', ['-lc', script], { timeoutMs })
  return { code: result.exit_code, out: (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim() }
}

export async function must(vm: Sandbox, script: string, timeoutMs?: number): Promise<string> {
  const r = await sh(vm, script, timeoutMs)
  if (r.code !== 0) throw new Error(`VM command failed (${r.code}): ${script.slice(0, 120)}\n${r.out.slice(-1500)}`)
  return r.out
}

export const put = (vm: Sandbox, path: string, content: string) => vm.files.upload(path, content)

/** Start a long-running process; output goes to a log file in /run/m. */
export async function daemon(vm: Sandbox, name: string, script: string, cwd = '/root') {
  await vm.processes.create({ cmd: 'bash', args: ['-lc', `exec ${script} >/run/m/${name}.log 2>&1`], cwd })
}

/** Simulated time = real time + offset. Written before every clock advance. */
export const setOffset = (vm: Sandbox, seconds: number) => put(vm, '/run/m/offset', `${seconds >= 0 ? '+' : ''}${Math.round(seconds)}\n`)

export async function waitHttp(vm: Sandbox, url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await sh(vm, `curl -s -o /dev/null -w '%{http_code}' ${url}`, 15_000)
    if (/^[1-5]\d\d$/.test(r.out)) return // any HTTP answer: the relay rightly 400s an unsigned GET
    await new Promise((ok) => setTimeout(ok, 2000))
  }
  throw new Error(`${url} never answered inside the VM`)
}

/** CreateOS names are at most 22 chars: mq-<repo hash 8>-<commit 7>. */
export const snapshotName = (repo: string, commit: string) =>
  `mq-${createHash('sha1').update(repo.toLowerCase().replace(/(\.git)?\/?$/, '')).digest('hex').slice(0, 8)}-${commit.slice(0, 7)}`

export async function findSandbox(name: string): Promise<Sandbox | undefined> {
  const all = await createos().listSandboxes()
  return all.find((s) => s.name === name && !['destroyed', 'failed'].includes(String(s.status)))
}
