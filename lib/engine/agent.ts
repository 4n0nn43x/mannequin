// The agent: an LLM with three tools on the VM (sh, write_file, read_file). It writes and runs the code that lets
// Mannequin BE a customer of the app (seed, session) and the patch. It never touches the verdict or the policy.
import OpenAI from 'openai'
import type { Sandbox } from '@nodeops-createos/sandbox'
import { put, secret, sh } from './vm'

export type AgentEvent = { kind: 'think' | 'tool' | 'result'; text: string }

const llm = () =>
  new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.LLM_API_KEY ?? secret('DEEPSEEK_API_KEY', '.deepseek_key'),
  })
const MODEL = process.env.LLM_MODEL ?? 'deepseek-chat'

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'sh', description: 'Run a bash command in the VM (as root). Returns exit code and output (truncated).', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a file in the VM (overwrites).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file in the VM (truncated to 12000 chars).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
]

const SYSTEM = `You are Mannequin's agent, working as root inside a Linux microVM that holds a customer's web app in /root/app.
Your job is narrow: write and run small scripts that let a tester act as one of the app's customers, then verify them by running them.
Rules:
- Never modify the app's access-control or billing logic unless the task explicitly says you are writing a patch.
- Prefer the app's own libraries (ORM, auth library) loaded from /root/app/node_modules.
- Run what you write. If it fails, read the error, fix your script, run again.
- Keep tool outputs short (pipe through tail/head). Be fast: few, purposeful steps.
- Never print secrets: do not cat .env or grep values out of it; load it inside your scripts instead.
- When done, answer with a short final message that starts with DONE (or FAILED and why).`

/** Run one task to completion. Returns the final message. */
export async function agentTask(vm: Sandbox, task: string, onEvent: (e: AgentEvent) => void, maxTurns = 24): Promise<string> {
  const client = llm()
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: task },
  ]
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS, temperature: 0.2 })
    const msg = res.choices[0].message
    messages.push(msg)
    if (msg.content) onEvent({ kind: 'think', text: redact(msg.content) })
    if (!msg.tool_calls?.length) return msg.content ?? 'FAILED: empty answer'
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue
      let args: Record<string, string> = {}
      try { args = JSON.parse(call.function.arguments) } catch {}
      onEvent({ kind: 'tool', text: redact(describe(call.function.name, args)) })
      const out = await runTool(vm, call.function.name, args)
      onEvent({ kind: 'result', text: out.slice(0, 600) })
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, 12_000) })
    }
  }
  return 'FAILED: too many steps'
}

function describe(name: string, raw: Record<string, string>) {
  const a = { cmd: raw.cmd ?? raw.command ?? raw.script, path: raw.path ?? raw.file ?? raw.filename, content: raw.content ?? raw.text ?? raw.data }
  if (name === 'sh') return `$ ${a.cmd}`
  if (name === 'write_file') return `write ${a.path}\n${a.content ?? ''}`
  return `read ${a.path}`
}

/** Secrets never reach the LLM or the UI, even if the agent prints .env. */
export const redact = (s: string) =>
  s.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '$1_$2_***').replace(/\bwhsec_[A-Za-z0-9]+/g, 'whsec_***')
    .replace(/^(\w*(SECRET|TOKEN|KEY|PASSWORD)\w*)=.*$/gim, '$1=***')

async function runTool(vm: Sandbox, name: string, a: Record<string, string>): Promise<string> {
  return redact(await runToolRaw(vm, name, a))
}

async function runToolRaw(vm: Sandbox, name: string, raw: Record<string, string>): Promise<string> {
  // models sometimes rename arguments: accept the usual aliases, and say so loudly when one is missing
  const a = { cmd: raw.cmd ?? raw.command ?? raw.script, path: raw.path ?? raw.file ?? raw.filename, content: raw.content ?? raw.text ?? raw.data }
  const missing = name === 'sh' ? !a.cmd : name === 'write_file' ? !a.path || a.content === undefined : name === 'read_file' ? !a.path : false
  if (missing) return `error: bad arguments ${JSON.stringify(Object.keys(raw))}. Call ${name} with ${name === 'sh' ? '{"cmd": "..."}' : name === 'write_file' ? '{"path": "...", "content": "..."}' : '{"path": "..."}'}`
  try {
    if (name === 'sh') { const r = await sh(vm, a.cmd, 300_000); return `exit ${r.code}\n${r.out.slice(-8000)}` }
    if (name === 'write_file') { await put(vm, a.path, a.content ?? ''); return `wrote ${a.path}` }
    if (name === 'read_file') { const r = await sh(vm, `head -c 12000 ${JSON.stringify(a.path)}`); return r.out }
    return `unknown tool ${name}`
  } catch (e) {
    return `tool error: ${(e as Error).message}`
  }
}
