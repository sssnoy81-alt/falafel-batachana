import type { ReactNode } from 'react'
import Link from 'next/link'
import LegalFooter from './LegalFooter'
import { CUSTOMER_CONTACT } from './contact'

// Shared layout for the static policy pages (FALAFEL-SN-08D16). Server component; same dark palette as /order.

export const LEGAL_UPDATED = 'עודכן לאחרונה: אוקטובר 2026'

const C = { bg: '#0D0D0D', card: '#1A1A1A', border: '#2A2A2A', gold: '#FFD700', white: '#FFFFFF', text: '#E2E2E2', gray: '#B0B0B0' }

const contactLink = { display: 'inline-flex', alignItems: 'center', minHeight: 44, color: C.text, textDecoration: 'underline', textUnderlineOffset: 3 } as const

const navLink = { display: 'inline-flex', alignItems: 'center', minHeight: 44, color: C.gold, fontSize: 14, fontWeight: 700, textDecoration: 'none' } as const

export default function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main dir="rtl" style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: 'var(--font-heebo), Heebo, sans-serif' }}>
      <header style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
        <nav style={{ maxWidth: 720, margin: '0 auto', padding: '4px 16px', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <Link href="/order" style={navLink}>→ חזרה להזמנה</Link>
          <Link href="/" style={{ ...navLink, color: C.gray, fontWeight: 500 }}>לדף הבית</Link>
        </nav>
      </header>
      <article style={{ maxWidth: 720, margin: '0 auto', padding: '28px 16px 8px', fontSize: 16, lineHeight: 1.8, overflowWrap: 'anywhere' }}>
        <h1 style={{ color: C.white, fontSize: 26, fontWeight: 900, lineHeight: 1.35, margin: '0 0 6px' }}>{title}</h1>
        <p style={{ color: C.gray, fontSize: 13, margin: '0 0 24px' }}>{LEGAL_UPDATED}</p>
        <div className="legal-body">{children}</div>
        <section aria-labelledby="legal-contact" style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${C.border}` }}>
          <h2 id="legal-contact" style={{ color: C.white, fontSize: 17, fontWeight: 800, margin: '0 0 6px' }}>יצירת קשר</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 15, color: C.gray }}>
            <li>טלפון: <a href={CUSTOMER_CONTACT.phoneUrl} dir="ltr" style={contactLink}>{CUSTOMER_CONTACT.phoneDisplay}</a></li>
            <li>וואטסאפ: <a href={CUSTOMER_CONTACT.whatsappUrl} target="_blank" rel="noopener noreferrer" style={contactLink}>שליחת הודעה</a></li>
            <li>דוא״ל: <a href={CUSTOMER_CONTACT.emailUrl} dir="ltr" style={contactLink}>{CUSTOMER_CONTACT.email}</a></li>
          </ul>
        </section>
      </article>
      <LegalFooter />
      <style>{`.legal-body p { margin: 0 0 16px; } .legal-body ul { margin: 0 0 16px; padding: 0 20px 0 0; } .legal-body li { margin: 0 0 6px; }`}</style>
    </main>
  )
}
