'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://sqgnrzcmjhwgfjxocvlr.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZ25yemNtamh3Z2ZqeG9jdmxyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM2NzEwMSwiZXhwIjoyMDg3OTQzMTAxfQ.fAnUMR8cXgQ38VWz66UibT83u_JquuXeZRtpiYmbTzM'
)

export default function DashboardPage() {
  const [todayCount, setTodayCount] = useState<number | null>(null)
  const [todayRevenue, setTodayRevenue] = useState<number | null>(null)
  const [newOrders, setNewOrders] = useState<number | null>(null)

  useEffect(() => {
    const fetchStats = async () => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const { data } = await supabase
        .from('orders')
        .select('total_price, status')
        .gte('created_at', today.toISOString())
      if (data) {
        setTodayCount(data.length)
        setTodayRevenue(data.reduce((s, o) => s + (o.total_price || 0), 0))
        setNewOrders(data.filter(o => o.status === 'received').length)
      }
    }
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>
      <div style={{
        minHeight: '100vh', background: '#0D0D0D', color: '#fff',
        fontFamily: 'Heebo, sans-serif', direction: 'rtl', padding: '24px 16px',
      }}>
        <h1 style={{ color: '#FFD700', fontSize: 24, fontWeight: 800, marginBottom: 8 }}>
          🧆 פלאפל בתחנה — ניהול
        </h1>
        <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 28 }}>דשבורד ניהול</p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
          {[
            { label: 'הזמנות היום', value: todayCount ?? '...', color: '#60A5FA' },
            { label: 'הכנסות היום', value: todayRevenue != null ? `\u20AA${todayRevenue}` : '...', color: '#4ADE80' },
            { label: 'ממתינות', value: newOrders ?? '...', color: '#FFD700' },
          ].map(stat => (
            <div key={stat.label} style={{
              flex: '1 1 100px', background: '#1A1A1A', borderRadius: 12,
              border: '1px solid #2A2A2A', padding: '16px 14px', textAlign: 'center',
            }}>
              <div style={{ color: stat.color, fontSize: 28, fontWeight: 800 }}>{stat.value}</div>
              <div style={{ color: '#9CA3AF', fontSize: 12, marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <a href="/dashboard/orders" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#1A1A1A', border: '1px solid #333', borderRadius: 14,
            padding: '18px 20px', textDecoration: 'none', color: '#fff',
          }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>📋 ניהול הזמנות</div>
              <div style={{ color: '#9CA3AF', fontSize: 12, marginTop: 2 }}>קנבן, קידום סטטוסים, היסטוריה</div>
            </div>
            {newOrders != null && newOrders > 0 && (
              <span style={{
                background: '#FFD700', color: '#000', borderRadius: 20,
                padding: '3px 12px', fontSize: 13, fontWeight: 700,
              }}>{newOrders} חדשות!</span>
            )}
          </a>
          <a href="/" style={{
            background: '#111', border: '1px solid #222', borderRadius: 14,
            padding: '18px 20px', textDecoration: 'none', color: '#9CA3AF', fontSize: 14,
            display: 'block',
          }}>
            🏠 חזור לאפליקציית לקוח
          </a>
        </div>
      </div>
    </>
  )
}