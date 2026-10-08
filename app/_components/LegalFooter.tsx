import Link from 'next/link'

// Customer-facing policy links (FALAFEL-SN-08D16). Static, no state — usable from server and client pages.
// In normal page flow (never fixed), so it can't cover fixed / sticky order controls.

export const LEGAL_LINKS = [
  { href: '/terms', label: 'תקנון' },
  { href: '/privacy', label: 'פרטיות' },
  { href: '/delivery-policy', label: 'משלוחים' },
  { href: '/refund-policy', label: 'ביטולים והחזרים' },
] as const

interface Props {
  /** Open in a new tab — used inside /order so an in-progress checkout (address, GPS, payment) is not lost. */
  newTab?: boolean
}

export default function LegalFooter({ newTab = false }: Props) {
  const tab = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  return (
    <footer dir="rtl" aria-label="מידע משפטי"
      style={{ width: '100%', padding: '20px 16px 8px', fontFamily: 'var(--font-heebo), Heebo, sans-serif', boxSizing: 'border-box' }}>
      <nav style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 6px', maxWidth: 480, margin: '0 auto' }}>
        {LEGAL_LINKS.map(l => (
          <Link key={l.href} href={l.href} {...tab}
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 10px', color: '#9A9A9A', fontSize: 13, textDecoration: 'underline', textUnderlineOffset: 3 }}>
            {l.label}
          </Link>
        ))}
      </nav>
    </footer>
  )
}
