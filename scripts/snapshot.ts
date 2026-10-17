// Prepare (or find) the paused snapshot for a repo: npx tsx scripts/snapshot.ts [repo]
import { ensureSnapshot } from '../lib/engine/run'
const repo = process.argv[2] ?? 'https://github.com/shadcn-ui/taxonomy'
ensureSnapshot(repo, undefined, (e) => console.log(JSON.stringify(e))).then((s) => { console.log('snapshot', s.name, s.status); process.exit(0) }, (e) => { console.error(e); process.exit(1) })
