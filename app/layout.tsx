import type { Metadata } from 'next'
import Link from 'next/link'
import './mannequin.css'

export const metadata: Metadata = { title: 'Mannequin', description: 'Crash-test customers for your Stripe subscriptions' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/dashtreme/css/bootstrap.min.css" />
        <link rel="stylesheet" href="/dashtreme/css/bootstrap-extended.css" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap" />
        <link rel="stylesheet" href="/dashtreme/css/app.css" />
        <link rel="stylesheet" href="/dashtreme/css/icons.css" />
      </head>
      <body className="bg-theme bg-theme1">
        <div className="wrapper">
          <div className="sidebar-wrapper">
            <div className="sidebar-header">
              <i className="bx bx-body fs-3 text-white" />
              <h4 className="logo-text">Mannequin</h4>
            </div>
            <ul className="metismenu" id="menu">
              <li><Link href="/"><div className="parent-icon"><i className="bx bx-play-circle" /></div><div className="menu-title">New run</div></Link></li>
              <li><Link href="/replay/sample"><div className="parent-icon"><i className="bx bx-movie-play" /></div><div className="menu-title">Replay demo</div></Link></li>
            </ul>
          </div>
          <header>
            <div className="topbar d-flex align-items-center">
              <nav className="navbar navbar-expand gap-3 w-100">
                <div className="text-white fw-bold d-lg-none">Mannequin</div>
                <div className="text-white-50">Crash-test customers for your Stripe subscriptions</div>
                <div className="ms-auto"><span className="badge bg-warning text-dark"><i className="bx bx-test-tube" /> Stripe test mode only</span></div>
              </nav>
            </div>
          </header>
          <div className="page-wrapper">
            <div className="page-content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  )
}
