import { Analytics } from '@vercel/analytics/react'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <head>
        <link rel="manifest" href="/manifest-kitchen.json" />
        <meta name="theme-color" content="#F97316" />
        <meta name="apple-mobile-web-app-title" content="מטבח פלאפל" />
      </head>
      {children}
      <Analytics />
    </>
  )
}