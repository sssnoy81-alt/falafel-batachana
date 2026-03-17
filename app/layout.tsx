import type { Metadata } from "next";
import { Heebo } from "next/font/google";
import "./globals.css";

const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["latin", "hebrew"],
});

export const metadata: Metadata = {
  title: "פלאפל בתחנה",
  description: "הזמנות אונליין — פלאפל בתחנה",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "פלאפל בתחנה",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <head>
        <meta name="theme-color" content="#0D0D0D" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="פלאפל בתחנה" />
        <link rel="apple-touch-icon" href="/logo-k.jpg" />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className={`${heebo.variable} antialiased`}>
        {children}
        <div style={{
          textAlign: 'center',
          marginTop: 30,
          paddingBottom: 20,
          color: '#888',
          fontSize: 11,
          letterSpacing: '0.04em',
          fontFamily: 'var(--font-heebo), sans-serif',
          userSelect: 'none',
          background: 'transparent',
        }}>
          Powered by SN Capital AI
        </div>
      </body>
    </html>
  );
}