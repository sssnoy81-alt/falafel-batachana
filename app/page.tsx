'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function Home() {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchTransactions()
  }, [])

  async function fetchTransactions() {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .order('date', { ascending: false })
    
    if (error) console.error(error)
    else setTransactions(data)
    setLoading(false)
  }

  return (
    <div style={{ padding: 20, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      <h1>פלאפל בתחנה 🧆</h1>
      {loading ? <p>טוען...</p> : <p>✅ מחובר ל-Supabase! {transactions.length} רשומות</p>}
    </div>
  )
}