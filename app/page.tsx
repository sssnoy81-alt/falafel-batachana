'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

const LOGO = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg'
const HERO_BG = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/hero-bg.jpg'

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: '#0D0D0D', fontFamily: 'Heebo, sans-serif', direction: 'rtl', color: '#fff' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0D0D0D; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
        .fade-up { animation: fadeUp 0.8s ease forwards; }
        .float { animation: float 3s ease-in-out infinite; }
        .btn-order:hover { transform: scale(1.04); box-shadow: 0 12px 40px rgba(255,215,0,0.5) !important; }
        .btn-menu:hover { transform: scale(1.04); border-color: #FFD700 !important; color: #FFD700 !important; }
        .social-btn:hover { transform: scale(1.1); opacity: 1 !important; }
        .btn-order, .btn-menu, .social-btn { transition: all 0.2s ease; }
      `}</style>

      {/* ── NAVBAR ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        padding: '14px 24px',
        background: scrolled ? 'rgba(13,13,13,0.95)' : 'transparent',
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        borderBottom: scrolled ? '1px solid rgba(255,215,0,0.15)' : 'none',
        transition: 'all 0.3s',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <img src={LOGO} alt="פלאפל בתחנה" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 12 }} />
        <div style={{ display: 'flex', gap: 12 }}>
          <Link href="/order" style={{
            background: '#FFD700', color: '#000', borderRadius: 12,
            padding: '8px 20px', fontWeight: 800, fontSize: 14,
            textDecoration: 'none', display: 'inline-block',
          }}>להזמנות</Link>
        </div>
      </nav>

      {/* ── HERO ── */}
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(to bottom, rgba(13,13,13,0.3) 0%, rgba(13,13,13,0.7) 60%, #0D0D0D 100%), url(https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/hero-falafel.jpg) center/cover no-repeat',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '100px 24px 60px', textAlign: 'center',
      }}>
        <img
          src={LOGO}
          alt="פלאפל בתחנה"
          className="float"
          style={{ width: 160, height: 160, objectFit: 'contain', marginBottom: 24, borderRadius: 24, boxShadow: '0 0 60px rgba(255,215,0,0.3)' }}
        />
        <h1 className="fade-up" style={{
          fontSize: 'clamp(42px, 10vw, 72px)', fontWeight: 900,
          color: '#fff', marginBottom: 12, lineHeight: 1.1,
          textShadow: '0 4px 20px rgba(0,0,0,0.5)',
        }}>
          פלאפל בתחנה
        </h1>
        <p className="fade-up" style={{
          fontSize: 'clamp(18px, 4vw, 26px)', color: '#FFD700',
          fontWeight: 700, marginBottom: 40,
          animationDelay: '0.2s',
        }}>
          הרבה יותר מפלאפל
        </p>

        <div className="fade-up" style={{
          display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center',
          animationDelay: '0.4s',
        }}>
          <Link href="/order" className="btn-order" style={{
            background: '#FFD700', color: '#000',
            borderRadius: 18, padding: '16px 40px',
            fontWeight: 900, fontSize: 20,
            textDecoration: 'none', display: 'inline-block',
            boxShadow: '0 8px 32px rgba(255,215,0,0.35)',
          }}>
            🛒 להזמנות
          </Link>
          <Link href="/order" className="btn-menu" style={{
            background: 'transparent', color: '#fff',
            border: '2px solid rgba(255,255,255,0.5)',
            borderRadius: 18, padding: '16px 40px',
            fontWeight: 800, fontSize: 20,
            textDecoration: 'none', display: 'inline-block',
          }}>
            📋 תפריט
          </Link>
        </div>

        {/* חץ גלילה */}
        <div style={{ marginTop: 60, color: 'rgba(255,255,255,0.4)', fontSize: 28, animation: 'float 2s ease-in-out infinite' }}>↓</div>
      </div>

      {/* ── ABOUT ── */}
      <div style={{ padding: '80px 24px', maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ fontSize: 40, fontWeight: 900, color: '#FFD700', marginBottom: 24 }}>קצת עלינו</h2>
        <p style={{ fontSize: 18, color: '#D1D5DB', lineHeight: 1.9, marginBottom: 16 }}>
          פלאפל בתחנה היא רשת מזון מהיר שהוקמה בשנת 2012 על ידי שני חברים עם חלום פשוט: להגיש את מנת הפלאפל המושלמת.
        </p>
        <p style={{ fontSize: 18, color: '#D1D5DB', lineHeight: 1.9 }}>
          הסיפור התחיל בעגלה קטנה וצנועה בתחנת דלק, מקום שהפך במהרה לנקודת מפגש מוכרת ואהובה. עם השנים, בזכות טעם ייחודי, הקפדה על איכות וחיבור אמיתי ללקוחות, הרשת צמחה והתפתחה.
        </p>
      </div>

      {/* ── INFO CARDS ── */}
      <div style={{ padding: '0 24px 80px', maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {[
            { icon: '📍', title: 'מישור אדומים', sub: 'מרכז מסחרי מתחם Gamos', href: 'https://waze.com/ul/hsv9hu47xz' },
            { icon: '📞', title: '058-5505014', sub: 'התקשרו אלינו', href: 'tel:0585505014' },
            { icon: '🕙', title: 'שעות פתיחה', sub: 'א׳–ה׳ 10:30–20:00 | שישי 10:30–14:00', href: null },
          ].map((card, i) => (
            <a key={i} href={card.href || '#'} target={card.href?.startsWith('http') ? '_blank' : '_self'} rel="noreferrer"
              style={{
                background: '#1A1A1A', border: '1px solid #2A2A2A', borderRadius: 20,
                padding: '24px 20px', textAlign: 'center', textDecoration: 'none',
                display: 'block', transition: 'border-color 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#FFD700')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#2A2A2A')}
            >
              <div style={{ fontSize: 36, marginBottom: 10 }}>{card.icon}</div>
              <div style={{ color: '#FFD700', fontWeight: 800, fontSize: 16, marginBottom: 6 }}>{card.title}</div>
              <div style={{ color: '#9CA3AF', fontSize: 13 }}>{card.sub}</div>
            </a>
          ))}
        </div>
      </div>

      {/* ── CTA ── */}
      <div style={{
        padding: '80px 24px', textAlign: 'center',
        background: 'linear-gradient(to bottom, #0D0D0D, #1A1100, #0D0D0D)',
      }}>
        <h2 style={{ fontSize: 36, fontWeight: 900, color: '#fff', marginBottom: 12 }}>
          רעבים? 🧆
        </h2>
        <p style={{ color: '#9CA3AF', fontSize: 18, marginBottom: 32 }}>הזמינו עכשיו וקבלו הנחה 5% באפליקציה</p>
        <Link href="/order" style={{
          background: '#FFD700', color: '#000',
          borderRadius: 18, padding: '18px 48px',
          fontWeight: 900, fontSize: 22,
          textDecoration: 'none', display: 'inline-block',
          boxShadow: '0 8px 40px rgba(255,215,0,0.4)',
          transition: 'transform 0.2s',
        }}>
          הזמינו עכשיו ←
        </Link>
      </div>

      {/* ── FOOTER ── */}
      <footer style={{
        background: '#111', borderTop: '1px solid #222',
        padding: '40px 24px', textAlign: 'center',
      }}>
        <img src={LOGO} alt="פלאפל בתחנה" style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 14, marginBottom: 20 }} />

        {/* סושיאל */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginBottom: 24 }}>
          <a href="https://www.instagram.com/falafelbatahana?igsh=MWprbTlvanRmNDBiZw" target="_blank" rel="noreferrer"
            className="social-btn"
            style={{ width: 52, height: 52, borderRadius: 16, background: 'linear-gradient(135deg, #f09433 0%,#e6683c 25%,#dc2743 50%,#cc2366 75%,#bc1888 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, opacity: 0.9, textDecoration: 'none' }}>
            📸
          </a>
          <a href="https://www.facebook.com/share/1HkhSQXYAo/" target="_blank" rel="noreferrer"
            className="social-btn"
            style={{ width: 52, height: 52, borderRadius: 16, background: '#1877F2', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, opacity: 0.9, textDecoration: 'none' }}>
            👥
          </a>
          <a href="https://www.tiktok.com/@falafel.batachana?_r=1&_t=ZS-95y8O4y6vjx" target="_blank" rel="noreferrer"
            className="social-btn"
            style={{ width: 52, height: 52, borderRadius: 16, background: '#010101', border: '1px solid #333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, opacity: 0.9, textDecoration: 'none' }}>
            🎵
          </a>
        </div>

        <div style={{ color: '#4B5563', fontSize: 13 }}>
          © 2025 פלאפל בתחנה | מישור אדומים
        </div>
        <div style={{ color: '#374151', fontSize: 11, marginTop: 6 }}>
          Powered by SN Capital AI
        </div>
      </footer>
    </div>
  )
}