import type { Metadata } from 'next'
import Link from 'next/link'
import './mannequin.css'

export const metadata: Metadata = { title: 'Mannequin', description: 'Crash-test customers for your Stripe subscriptions' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;600&family=Pixelify+Sans:wght@400;500;600&display=swap" />
      </head>
      <body>
        <header className="top">
          <div className="top-in">
            <Link href="/" className="brand"><span className="target" aria-hidden /> Mannequin</Link>
            <nav className="nav">
              <Link href="/">New run</Link>
              <Link href="/replay/sample">Replay demo</Link>
              <Link href="/my-runs">My runs</Link>
            </nav>
            <span className="testmode">Stripe test mode only</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
