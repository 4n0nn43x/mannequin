import RunView from '@/app/run-view'

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RunView src={`/api/runs/${encodeURIComponent(id)}/events`} title="Live run" runId={id} />
}
