'use client'
import Link from 'next/link'

const LOGO = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg'
const KID  = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/kid-character.png'
const DISH = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/falafel-dish.png'
const BG   = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/hero-bg.jpg'

const INSTAGRAM = 'https://www.instagram.com/falafelbatahana?igsh=MWprbTlvanRmNDBiZw'
const FACEBOOK  = 'https://www.facebook.com/share/1HkhSQXYAo/'
const TIKTOK    = 'https://www.tiktok.com/@falafel.batachana?_r=1&_t=ZS-95y8O4y6vjx'

export default function LandingPage() {
  return (
    <div style={{ fontFamily: "'Heebo', sans-serif", direction: 'rtl', margin: 0, padding: 0, overflowX: 'hidden' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;800;900&family=Rubik+Dirt&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111; }
        .hero-title {
          font-family: 'Rubik Dirt', 'Heebo', sans-serif;
          font-size: clamp(52px, 12vw, 96px);
          color: #fff;
          line-height: 1;
          text-shadow: 3px 3px 0px rgba(0,0,0,0.5);
          letter-spacing: -2px;
        }
        .hero-subtitle {
          font-family: 'Heebo', sans-serif;
          font-size: clamp(20px, 5vw, 34px);
          font-weight: 800;
          color: #fff;
          letter-spacing: 1px;
          margin-top: 8px;
          text-shadow: 1px 1px 4px rgba(0,0,0,0.7);
        }
        .btn-order {
          background: #F5F0E0;
          color: #1a1a1a;
          border: none;
          border-radius: 50px;
          padding: 14px 42px;
          font-size: clamp(22px, 5vw, 28px);
          font-weight: 900;
          font-family: 'Heebo', sans-serif;
          cursor: pointer;
          box-shadow: 0 6px 0 #b8a87a, 0 8px 20px rgba(0,0,0,0.4);
          text-decoration: none;
          display: inline-block;
          transition: transform 0.1s, box-shadow 0.1s;
        }
        .btn-order:hover { transform: translateY(2px); box-shadow: 0 4px 0 #b8a87a; }
        .btn-menu {
          background: #111;
          color: #7EFFD4;
          border: 2px solid #333;
          border-radius: 50px;
          padding: 14px 42px;
          font-size: clamp(22px, 5vw, 28px);
          font-weight: 900;
          font-family: 'Heebo', sans-serif;
          cursor: pointer;
          box-shadow: 0 6px 0 #000, 0 8px 20px rgba(0,0,0,0.6);
          text-decoration: none;
          display: inline-block;
          transition: transform 0.1s, box-shadow 0.1s;
        }
        .btn-menu:hover { transform: translateY(2px); box-shadow: 0 4px 0 #000; }
        .section-title {
          font-family: 'Rubik Dirt', 'Heebo', sans-serif;
          font-size: clamp(48px, 10vw, 80px);
          color: #F5C842;
          line-height: 1;
          text-shadow: 3px 3px 0px rgba(0,0,0,0.6);
        }
        .social-icon { transition: transform 0.2s; display: inline-block; }
        .social-icon:hover { transform: scale(1.15); }
      `}</style>

      {/* ══════════════════════════════════
          HERO — עמוד 1
      ══════════════════════════════════ */}
      <div style={{
        position: 'relative',
        minHeight: '100vh',
        background: `linear-gradient(rgba(20,10,3,0.4), rgba(5,2,0,0.72)), url(${BG}) center/cover no-repeat`,
        backgroundColor: '#2D1A0A',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, padding: '24px 24px 0', flexWrap: 'wrap' }}>
          <img
            src={LOGO}
            alt="לוגו"
            onError={e => { (e.target as HTMLImageElement).style.display='none' }}
            style={{ width: 110, height: 110, objectFit: 'contain', borderRadius: '50%', border: '3px solid rgba(255,255,255,0.25)', flexShrink: 0 }}
          />
          <div style={{ paddingTop: 8 }}>
            <div className="hero-title">פלאפל בתחנה</div>
            <div className="hero-subtitle">הרבה יותר מפלאפל</div>
          </div>
        </div>

        {/* כפתורים */}
        <div style={{ display: 'flex', gap: 16, padding: '32px 24px 0', flexWrap: 'wrap' }}>
          <Link href="/order" className="btn-menu">תפריט</Link>
          <Link href="/order" className="btn-order">להזמנות</Link>
        </div>

        {/* תחתית — דמות + מנה + סושיאל */}
        <div style={{ flex: 1, position: 'relative', minHeight: 360 }}>

          {/* מנה — ימין */}
          <img
            src={DISH}
            alt="מנת פלאפל"
            onError={e => { (e.target as HTMLImageElement).style.display='none' }}
            style={{
              position: 'absolute', bottom: 60, right: '4%',
              width: 'clamp(240px, 52%, 460px)',
              objectFit: 'contain',
              filter: 'drop-shadow(0 20px 40px rgba(0,0,0,0.7))',
              zIndex: 2,
            }}
          />

          {/* דמות — שמאל */}
          <img
            src={KID}
            alt="דמות"
            onError={e => { (e.target as HTMLImageElement).style.display='none' }}
            style={{
              position: 'absolute', bottom: 50, left: '1%',
              width: 'clamp(170px, 33%, 270px)',
              objectFit: 'contain', zIndex: 3,
            }}
          />

          {/* אייקונים + כתובת */}
          <div style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 10,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
          }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <a href={TIKTOK} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#010101"/><path d="M32.8 19.3a7.5 7.5 0 01-4.4-1.4v9.8a7.1 7.1 0 11-7.1-7.1c.2 0 .4 0 .6.01v3.5a3.7 3.7 0 10-.6 7.3 3.7 3.7 0 003.7-3.7V12h3.5a7.5 7.5 0 007.5 7.1v.2z" fill="white"/></svg>
              </a>
              <a href={INSTAGRAM} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="48" height="48" viewBox="0 0 48 48"><defs><radialGradient id="ig1" cx="30%" cy="107%" r="150%"><stop offset="0%" stopColor="#fdf497"/><stop offset="45%" stopColor="#fd5949"/><stop offset="60%" stopColor="#d6249f"/><stop offset="90%" stopColor="#285AEB"/></radialGradient></defs><circle cx="24" cy="24" r="24" fill="url(#ig1)"/><rect x="14" y="14" width="20" height="20" rx="6" stroke="white" strokeWidth="2.5" fill="none"/><circle cx="24" cy="24" r="5" stroke="white" strokeWidth="2.5" fill="none"/><circle cx="30.5" cy="17.5" r="1.5" fill="white"/></svg>
              </a>
              <a href={FACEBOOK} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#1877F2"/><path d="M27.5 25.5h3l1-4H27.5v-2c0-1.1.4-2 1.5-2H32V14s-1.8-.3-3.5-.3c-3.6 0-6 2.1-6 6V21.5H19v4h3.5V36h4V25.5z" fill="white"/></svg>
              </a>
            </div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 13, textAlign: 'right', background: 'rgba(0,0,0,0.45)', borderRadius: 8, padding: '4px 10px' }}>
              די זהב 7 (מתחם גאמוס) &nbsp;|&nbsp;
              <a href="tel:0585505014" style={{ color: '#F5C842', textDecoration: 'none', fontWeight: 900 }}>0585505014</a>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════
          ABOUT — עמוד 2
      ══════════════════════════════════ */}
      <div style={{
        position: 'relative',
        minHeight: '100vh',
        background: 'radial-gradient(ellipse at 60% 0%, #1e1e1e 0%, #080808 80%)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* grain */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, opacity: 0.035,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundSize: '150px',
        }} />

        {/* כפתור להזמנות — שמאל למעלה */}
        <div style={{ padding: '28px 24px', position: 'relative', zIndex: 5 }}>
          <Link href="/order" className="btn-order" style={{ fontSize: 20, padding: '11px 34px' }}>להזמנות</Link>
        </div>

        {/* כותרת + טקסט */}
        <div style={{ flex: 1, padding: '0 24px 20px', position: 'relative', zIndex: 5 }}>
          <div className="section-title" style={{ textAlign: 'right', marginBottom: 28 }}>קצת עלינו</div>
          <div style={{
            color: '#fff', fontSize: 'clamp(17px, 4vw, 22px)',
            fontWeight: 700, lineHeight: 1.85, textAlign: 'right',
            maxWidth: 580, marginLeft: 'auto',
          }}>
            <p style={{ marginBottom: 14 }}>
              פלאפל בתחנה היא רשת מזון מהיר שהוקמה<br/>
              בשנת 2012 על ידי שני חברים עם חלום פשוט:<br/>
              <strong>להגיש את מנת הפלאפל המושלמת.</strong>
            </p>
            <p style={{ marginBottom: 14 }}>
              הסיפור התחיל בעגלה קטנה וצנועה<br/>
              בתחנת דלק, מקום שהפך במהרה לנקודת<br/>
              מפגש מוכרת ואהובה על לקוחות מכל האזור.
            </p>
            <p>
              עם השנים, בזכות טעם ייחודי, הקפדה על<br/>
              איכות וחיבור אמיתי ללקוחות, הרשת צמחה<br/>
              והתפתחה, <strong>וכיום מונה כארבעה סניפים.</strong>
            </p>
          </div>
        </div>

        {/* תחתית */}
        <div style={{ position: 'relative', minHeight: 260, zIndex: 5 }}>
          <img
            src={KID}
            alt="דמות"
            onError={e => { (e.target as HTMLImageElement).style.display='none' }}
            style={{
              position: 'absolute', bottom: 40, left: '1%',
              width: 'clamp(150px, 32%, 250px)',
              objectFit: 'contain', zIndex: 3,
            }}
          />
          <div style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 10,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
          }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <a href={TIKTOK} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="52" height="52" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#010101"/><path d="M32.8 19.3a7.5 7.5 0 01-4.4-1.4v9.8a7.1 7.1 0 11-7.1-7.1c.2 0 .4 0 .6.01v3.5a3.7 3.7 0 10-.6 7.3 3.7 3.7 0 003.7-3.7V12h3.5a7.5 7.5 0 007.5 7.1v.2z" fill="white"/></svg>
              </a>
              <a href={INSTAGRAM} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="52" height="52" viewBox="0 0 48 48"><defs><radialGradient id="ig2" cx="30%" cy="107%" r="150%"><stop offset="0%" stopColor="#fdf497"/><stop offset="45%" stopColor="#fd5949"/><stop offset="60%" stopColor="#d6249f"/><stop offset="90%" stopColor="#285AEB"/></radialGradient></defs><circle cx="24" cy="24" r="24" fill="url(#ig2)"/><rect x="14" y="14" width="20" height="20" rx="6" stroke="white" strokeWidth="2.5" fill="none"/><circle cx="24" cy="24" r="5" stroke="white" strokeWidth="2.5" fill="none"/><circle cx="30.5" cy="17.5" r="1.5" fill="white"/></svg>
              </a>
              <a href={FACEBOOK} target="_blank" rel="noreferrer" className="social-icon">
                <svg width="52" height="52" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#1877F2"/><path d="M27.5 25.5h3l1-4H27.5v-2c0-1.1.4-2 1.5-2H32V14s-1.8-.3-3.5-.3c-3.6 0-6 2.1-6 6V21.5H19v4h3.5V36h4V25.5z" fill="white"/></svg>
              </a>
            </div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 13, textAlign: 'right' }}>
              די זהב 7 (מתחם גאמוס) &nbsp;|&nbsp;
              <a href="tel:0585505014" style={{ color: '#F5C842', textDecoration: 'none', fontWeight: 900 }}>0585505014</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}