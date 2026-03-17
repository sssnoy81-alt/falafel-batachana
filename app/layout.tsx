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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className={`${heebo.variable} antialiased`}>
        {children}
        <div style={{
          textAlign: 'center',
          padding: '12px 0 16px',
          color: '#3A3A3A',
          fontSize: 11,
          letterSpacing: '0.04em',
          fontFamily: 'var(--font-heebo), sans-serif',
          userSelect: 'none',
        }}>
          Powered by SN Capital AI
        </div>
      </body>
    </html>
  );
}