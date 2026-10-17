import RunView from '@/app/run-view'

export default async function ReplayPage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ speed?: string }> }) {
  const { name } = await params
  const speed = Number((await searchParams).speed) || 4
  return <RunView src={`/api/replay/${encodeURIComponent(name)}/events?speed=${speed}`} title={`Replay: ${name} (x${speed})`} />
}
