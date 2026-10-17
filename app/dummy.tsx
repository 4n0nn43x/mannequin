// Pixel-art crash-test dummy (10x14 grid). K = outline, Y = body (colored by state), M = target marker.
const SPRITE = [
  '...KKKK...',
  '..KYYYYK..',
  '.KYKYYKYK.',
  '.KYYYYYYK.',
  '..KYYYYK..',
  '...KKKK...',
  '.KKYYYYKK.',
  'KYYYMKYYYK',
  'KYYYKMYYYK',
  'KYKYYYYKYK',
  '.KKYYYYKK.',
  '..KYKKYK..',
  '..KYK.KYK.',
  '..KKK.KKK.',
]

export type DummyState = 'idle' | 'green' | 'red' | 'orange' | 'grey'
const BODY: Record<DummyState, string> = { idle: 'var(--dummy)', green: 'var(--dummy)', red: 'var(--bad)', orange: 'var(--warn)', grey: 'var(--grey)' }

export default function Dummy({ state = 'idle', size = 28, walk = false }: { state?: DummyState; size?: number; walk?: boolean }) {
  return (
    <svg className={`dummy ${walk ? 'walk' : ''} ${state === 'red' ? 'shake' : ''}`} width={size} height={size * 1.4} viewBox="0 0 10 14" shapeRendering="crispEdges" aria-hidden>
      {SPRITE.flatMap((row, y) => [...row].map((p, x) =>
        p === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={p === 'Y' ? BODY[state] : p === 'M' ? 'var(--dummy)' : 'var(--black)'} />,
      ))}
    </svg>
  )
}
