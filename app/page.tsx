'use client'

import Image from 'next/image'

const ASSET_PATH = '/falafel-landing'

export default function Home() {
  const orderUrl = '/order'
  const phoneUrl = 'tel:0585505014'
  const whatsappUrl = 'https://wa.me/972585505014'
  const emailUrl = 'mailto:falafel.b001@gmail.com'
  const wazeUrl = 'https://waze.com/ul?q=%D7%93%D7%99%20%D7%96%D7%94%D7%91%207%20%D7%9E%D7%AA%D7%97%D7%9D%20%D7%92%D7%90%D7%9E%D7%95%D7%A1&navigate=yes'
  const facebookUrl = 'https://www.facebook.com/share/1HkhSQXYAo/'
  const instagramUrl = 'https://www.instagram.com/falafelbatahana?igsh=MWprbTlvanRmNDBiZw'
  const tiktokUrl = 'https://www.tiktok.com/@falafel.batachana?_r=1&_t=ZS-95y8O4y6vjx'

  const scrollToMenu = () => {
    const el = document.getElementById('menu-section')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <main className="falafel-site" dir="rtl">
      <header className="floating-header" aria-label="כותרת פלאפל בתחנה">
        <div className="floating-header-inner">
          <Image
            src={`${ASSET_PATH}/flow-title-falfel.png`}
            alt="פלאפל בתחנה - כותרת צפה"
            width={2048}
            height={160}
            priority
            className="floating-header-img"
          />

          <a href={phoneUrl} className="header-hotspot header-phone" aria-label="התקשרו לפלאפל בתחנה" />

          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="header-hotspot header-order"
            aria-label="להזמנות בוואטסאפ"
          />

          <button
            type="button"
            onClick={scrollToMenu}
            className="header-hotspot header-menu"
            aria-label="מעבר לתפריט"
          />
        </div>
      </header>

      <section className="pdf-page hero-section" aria-label="מסך פתיחה">
        <Image
          src={`${ASSET_PATH}/landing-page-1.png`}
          alt="פלאפל בתחנה - הרבה יותר מפלאפל"
          width={768}
          height={1024}
          priority
          className="pdf-img"
        />

        <a
          href={orderUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="page-hotspot hero-order"
          aria-label="להזמנות"
        />

        <button type="button" onClick={scrollToMenu} className="page-hotspot hero-menu" aria-label="מעבר לתפריט" />

        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="page-hotspot hero-whatsapp"
          aria-label="וואטסאפ להזמנות"
        />
      </section>

      <section className="pdf-page atmosphere-section" aria-label="האווירה אצלנו">
        <Image
          src={`${ASSET_PATH}/landing-page-2.png`}
          alt="האווירה אצלנו"
          width={768}
          height={1024}
          className="pdf-img"
        />

        <div className="video-layer">
          <video
            src={`${ASSET_PATH}/falfel_video.mp4`}
            className="falafel-video"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
          />
        </div>
      </section>

      <section id="menu-section" className="pdf-page menu-section" aria-label="התפריט שלנו">
        <Image
          src={`${ASSET_PATH}/landing-page-3.png`}
          alt="התפריט שלנו"
          width={768}
          height={1024}
          className="pdf-img"
        />

        <a
          href={orderUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="page-hotspot menu-order"
          aria-label="להזמנות מהתפריט"
        />
      </section>

      <section className="pdf-page about-section" aria-label="קצת עלינו">
        <Image
          src={`${ASSET_PATH}/landing-page-4.png`}
          alt="קצת עלינו - פלאפל בתחנה"
          width={768}
          height={1024}
          className="pdf-img"
        />
      </section>

      <section className="pdf-page contact-section" aria-label="צור קשר">
        <Image
          src={`${ASSET_PATH}/landing-page-5.png`}
          alt="צור קשר ועקבו אחרינו"
          width={768}
          height={1024}
          className="pdf-img"
        />

        <a href={emailUrl} className="page-hotspot contact-email" aria-label="שליחת מייל" />
        <a href={phoneUrl} className="page-hotspot contact-phone" aria-label="התקשרו" />

        <a href={facebookUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot social-main-facebook" aria-label="פייסבוק" />
        <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot social-main-instagram" aria-label="אינסטגרם" />
        <a href={tiktokUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot social-main-tiktok" aria-label="טיקטוק" />

        <a href={orderUrl} className="page-hotspot bottom-order" aria-label="להזמנות" />
        <a href={wazeUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot bottom-waze" aria-label="וויז" />
        <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot bottom-whatsapp" aria-label="וואטסאפ" />
        <a href={tiktokUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot bottom-tiktok" aria-label="טיקטוק" />
        <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot bottom-instagram" aria-label="אינסטגרם" />
        <a href={facebookUrl} target="_blank" rel="noopener noreferrer" className="page-hotspot bottom-facebook" aria-label="פייסבוק" />
      </section>

      <style jsx global>{`
        * {
          box-sizing: border-box;
        }

        html {
          scroll-behavior: smooth;
          background: #000;
        }

        body {
          margin: 0;
          background: #000 !important;
          color: #fff;
          overflow-x: hidden;
        }

        .falafel-site {
          width: 100%;
          min-height: 100vh;
          background: #000;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding-top: clamp(48px, 6.4vw, 82px);
        }

        .floating-header {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          z-index: 9999;
          background: #000;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 8px 18px;
          border-bottom: 1px solid rgba(255, 215, 120, 0.18);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
          overflow: hidden;
        }

        .floating-header-inner {
          position: relative;
          width: min(100%, 2048px);
          max-width: calc(100vw - 36px);
          line-height: 0;
        }

        .floating-header-img {
          width: 100%;
          height: auto;
          max-height: clamp(58px, 7vw, 118px);
          display: block;
          object-fit: contain;
          object-position: center center;
          user-select: none;
          pointer-events: none;
        }

        .header-hotspot,
        .page-hotspot {
          position: absolute;
          display: block;
          border: 0;
          padding: 0;
          margin: 0;
          background: transparent;
          cursor: pointer;
          z-index: 5;
        }

        .header-hotspot:focus-visible,
        .page-hotspot:focus-visible {
          outline: 3px solid #ffd700;
          outline-offset: 3px;
          border-radius: 12px;
        }

        .header-phone {
          left: 9.5%;
          top: 22%;
          width: 6.5%;
          height: 56%;
          border-radius: 999px;
        }

        .header-order {
          left: 39%;
          top: 8%;
          width: 22%;
          height: 78%;
          border-radius: 999px;
        }

        .header-menu {
          right: 1.7%;
          top: 7%;
          width: 5.9%;
          height: 78%;
          border-radius: 18px;
        }

        .pdf-page {
          position: relative;
          width: 100%;
          max-width: min(900px, 100vw);
          background: #000;
          line-height: 0;
          overflow: hidden;
        }

        .pdf-img {
          display: block;
          width: 100%;
          height: auto;
          object-fit: contain;
          user-select: none;
        }

        .hero-order {
          left: 30%;
          top: 17%;
          width: 25%;
          height: 7%;
          border-radius: 999px;
        }

        .hero-menu {
          right: 13%;
          top: 17%;
          width: 29%;
          height: 7%;
          border-radius: 999px;
        }

        .hero-whatsapp {
          right: 3.5%;
          bottom: 4%;
          width: 9%;
          height: 8%;
          border-radius: 999px;
        }

        .video-layer {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 38%;
          z-index: 4;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          margin: 0;
          overflow: hidden;
          background: #000;
          border: none;
          box-shadow: none;
          border-radius: 0;
          backdrop-filter: none;
        }

        .falafel-video {
          width: 100%;
          height: 100%;
          display: block;
          object-fit: contain;
          object-position: center center;
          border-radius: 0;
          background: #000;
          pointer-events: none;
        }

        .menu-order {
          left: 48%;
          top: 16%;
          width: 29%;
          height: 7%;
          border-radius: 999px;
        }

        .contact-email {
          left: 17%;
          top: 19%;
          width: 51%;
          height: 6%;
        }

        .contact-phone {
          left: 32%;
          top: 28%;
          width: 40%;
          height: 6%;
        }

        .contact-order {
          left: 5%;
          bottom: 4%;
          width: 27%;
          height: 7%;
          border-radius: 999px;
        }

        .contact-whatsapp {
          left: 45%;
          bottom: 4%;
          width: 8%;
          height: 7%;
          border-radius: 999px;
        }

                .hero-whatsapp {
          right: 3%;
          bottom: 4%;
          width: 10%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .contact-email {
          left: 15%;
          top: 18%;
          width: 56%;
          height: 7%;
          z-index: 30;
        }

        .contact-phone {
          left: 30%;
          top: 27%;
          width: 42%;
          height: 7%;
          z-index: 30;
        }

        .social-main-facebook {
          right: 14%;
          top: 37%;
          width: 18%;
          height: 13%;
          border-radius: 999px;
          z-index: 30;
        }

        .social-main-instagram {
          right: 14%;
          top: 51%;
          width: 18%;
          height: 13%;
          border-radius: 999px;
          z-index: 30;
        }

        .social-main-tiktok {
          right: 14%;
          top: 65%;
          width: 18%;
          height: 13%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-order {
          left: 4%;
          bottom: 4%;
          width: 29%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-waze {
          left: 49.5%;
          bottom: 4%;
          width: 7%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-whatsapp {
          left: 60.5%;
          bottom: 4%;
          width: 7%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-tiktok {
          left: 70%;
          bottom: 4%;
          width: 7%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-instagram {
          left: 79.5%;
          bottom: 4%;
          width: 7%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }

        .bottom-facebook {
          left: 89%;
          bottom: 4%;
          width: 7%;
          height: 9%;
          border-radius: 999px;
          z-index: 30;
        }
        @media (min-width: 900px) {
          .falafel-site {
            padding-top: 78px;
          }

          .pdf-page {
            max-width: min(900px, 100vw);
            box-shadow: 0 0 70px rgba(255, 210, 90, 0.09);
          }
        }

        @media (max-width: 600px) {
          .falafel-site {
            padding-top: 58px;
          }

          .floating-header-img {
          width: 100%;
          height: auto;
          max-height: clamp(58px, 7vw, 118px);
          display: block;
          object-fit: contain;
          object-position: center center;
          user-select: none;
          pointer-events: none;
        }

          .header-phone {
            left: 9%;
            top: 19%;
            width: 7.5%;
            height: 60%;
          }

          .header-order {
            left: 39%;
            top: 11%;
            width: 23%;
            height: 72%;
          }

          .header-menu {
            right: 1.5%;
            top: 9%;
            width: 6.8%;
            height: 74%;
          }

          .video-layer {
            top: 0;
            left: 0;
            right: 0;
            height: 38%;
            padding: 0;
          }
        }
      `}</style>
    </main>
  )
}









