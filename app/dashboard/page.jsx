// @ts-nocheck

'use client'
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'

/* ── LOGO ── */
const LOGO = "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"

/* ── THEME ── */
const T = {
  teal:'#1A4D5C', tealD:'#0F3040',
  green:'#16A34A', greenS:'#DCFCE7',
  red:'#DC2626', redS:'#FEE2E2',
  amber:'#D97706', amberS:'#FEF3C7',
  bg:'#F0F4F7', card:'#FFFFFF',
  text:'#0F172A', sub:'#64748B', border:'#E2E8F0',
  chart:['#1A4D5C','#E07B39','#16A34A','#7C3AED','#0891B2','#DC2626','#D97706','#0D9488'],
}

const EXPENSE_CATS = ['חומרי גלם','עובדים','שכירות','חשמל / מים','שיווק','ציוד','אחר']
const fmt  = n => '₪' + Math.round(n||0).toLocaleString('he-IL')
const fmtK = n => (n||0)>=1000 ? '₪'+((n||0)/1000).toFixed(1)+'K' : fmt(n)
const fmtP = n => ((n||0)*100).toFixed(1)+'%'
const todayStr = () => new Date().toISOString().split('T')[0]

/* ── CARD ── */
function Card({ children, style={} }) {
  return <div style={{ background:T.card, borderRadius:14, padding:16, boxShadow:'0 1px 10px rgba(0,0,0,0.07)', ...style }}>{children}</div>
}

function CardTitle({ icon, title, sub }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontWeight:700, fontSize:14, color:T.text }}>{icon} {title}</div>
      {sub && <div style={{ fontSize:11, color:T.sub, marginTop:2 }}>{sub}</div>}
    </div>
  )
}

/* ── KPI CARD ── */
function KpiCard({ label, value, sub, subColor, icon, accent, isMobile }) {
  return (
    <div style={{ background:T.card, borderRadius:14, padding:isMobile?'14px':'18px 20px', borderRight:`4px solid ${accent}`, boxShadow:'0 2px 12px rgba(0,0,0,0.07)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <span style={{ fontSize:11, color:T.sub, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase' }}>{label}</span>
        <span style={{ fontSize:isMobile?18:22 }}>{icon}</span>
      </div>
      <div style={{ fontSize:isMobile?22:28, fontWeight:800, color:accent, fontFamily:"'DM Mono',monospace", letterSpacing:-1, marginTop:4 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:subColor||T.sub, fontWeight:500, marginTop:2 }}>{sub}</div>}
    </div>
  )
}

/* ── TOOLTIP ── */
function CTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', fontSize:12, direction:'rtl', fontFamily:'Heebo,sans-serif' }}>
      <div style={{ color:T.sub, marginBottom:6, fontWeight:600 }}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{ color:p.color, display:'flex', justifyContent:'space-between', gap:16 }}>
          <span>{p.name}</span>
          <span style={{ fontWeight:700 }}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ── ADD TRANSACTION MODAL ── */
function AddModal({ onAdd, onClose }) {
  const [form, setForm] = useState({ date:todayStr(), type:'expense', category:'חומרי גלם', amount:'', note:'' })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!form.amount) return
    setSaving(true)
    const { data, error } = await supabase.from('transactions').insert([{
      date: form.date,
      type: form.type,
      category: form.category,
      amount: parseFloat(form.amount),
      note: form.note,
    }]).select()
    if (!error) onAdd(data[0])
    setSaving(false)
    onClose()
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'flex-end', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:T.card, borderRadius:'20px 20px 0 0', padding:'24px 20px 32px', width:'100%', maxWidth:520 }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:40, height:4, background:T.border, borderRadius:2, margin:'0 auto 20px' }}/>
        <div style={{ fontWeight:700, fontSize:17, color:T.text, marginBottom:16 }}>➕ הוסף תנועה</div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
          <div>
            <label style={{ fontSize:11, color:T.sub, display:'block', marginBottom:3 }}>תאריך</label>
            <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}
              style={{ width:'100%', padding:'9px 10px', border:`1px solid ${T.border}`, borderRadius:8, fontSize:13, fontFamily:'Heebo,sans-serif', boxSizing:'border-box' }}/>
          </div>
          <div>
            <label style={{ fontSize:11, color:T.sub, display:'block', marginBottom:3 }}>סכום (₪)</label>
            <input type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} placeholder="0"
              style={{ width:'100%', padding:'9px 10px', border:`1px solid ${T.border}`, borderRadius:8, fontSize:13, fontFamily:'Heebo,sans-serif', boxSizing:'border-box' }}/>
          </div>
          <div>
            <label style={{ fontSize:11, color:T.sub, display:'block', marginBottom:3 }}>סוג</label>
            <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value,category:e.target.value==='income'?'מכירות':'חומרי גלם'}))}
              style={{ width:'100%', padding:'9px 10px', border:`1px solid ${T.border}`, borderRadius:8, fontSize:13, fontFamily:'Heebo,sans-serif' }}>
              <option value="income">הכנסה</option>
              <option value="expense">הוצאה</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize:11, color:T.sub, display:'block', marginBottom:3 }}>קטגוריה</label>
            <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}
              style={{ width:'100%', padding:'9px 10px', border:`1px solid ${T.border}`, borderRadius:8, fontSize:13, fontFamily:'Heebo,sans-serif' }}>
              {(form.type==='income'?['מכירות','אחר']:EXPENSE_CATS).map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:11, color:T.sub, display:'block', marginBottom:3 }}>הערה</label>
          <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="אופציונלי"
            style={{ width:'100%', padding:'9px 10px', border:`1px solid ${T.border}`, borderRadius:8, fontSize:13, fontFamily:'Heebo,sans-serif', boxSizing:'border-box' }}/>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={submit} disabled={saving} style={{ flex:1, padding:'13px', background:T.green, color:'#fff', border:'none', borderRadius:12, fontSize:15, fontWeight:700, cursor:'pointer', fontFamily:'Heebo,sans-serif' }}>
            {saving ? '⏳ שומר...' : '✓ שמור'}
          </button>
          <button onClick={onClose} style={{ padding:'13px 20px', background:T.bg, border:`1px solid ${T.border}`, color:T.sub, borderRadius:12, fontSize:14, cursor:'pointer', fontFamily:'Heebo,sans-serif' }}>ביטול</button>
        </div>
      </div>
    </div>
  )
}

/* ── AI ALERTS ── */
function AIAlerts({ txns }) {
  const alerts = []
  const income = txns.filter(t=>t.type==='income')
  const totalSales = income.reduce((s,t)=>s+t.amount,0)
  const totalRaw   = txns.filter(t=>t.category==='חומרי גלם').reduce((s,t)=>s+t.amount,0)
  const totalLabor = txns.filter(t=>t.category==='עובדים').reduce((s,t)=>s+t.amount,0)
  const foodCostPct = totalSales>0 ? totalRaw/totalSales : 0
  const laborPct    = totalSales>0 ? totalLabor/totalSales : 0

  if (foodCostPct>0.32) alerts.push({ type:'warn', msg:`Food Cost גבוה — ${fmtP(foodCostPct)} (יעד: מתחת ל-32%)`, icon:'🔴' })
  else if (foodCostPct>0) alerts.push({ type:'good', msg:`Food Cost תקין — ${fmtP(foodCostPct)} ✓`, icon:'🟢' })
  if (laborPct>0.28) alerts.push({ type:'warn', msg:`עלות עובדים גבוהה — ${fmtP(laborPct)} (יעד: מתחת ל-28%)`, icon:'⚠️' })
  if (!alerts.length) alerts.push({ type:'good', msg:'כל המדדים תקינים — העסק עובד מצוין! ✓', icon:'✅' })

  return (
    <Card>
      <CardTitle icon="🤖" title="התראות AI" sub="ניתוח אוטומטי"/>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {alerts.map((a,i) => (
          <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 14px', borderRadius:10,
            background:a.type==='warn'?'#FEF9C3':T.greenS,
            border:`1px solid ${a.type==='warn'?'#FDE68A':'#86EFAC'}`,
            fontSize:13, fontWeight:500, color:T.text }}>
            <span style={{ fontSize:16 }}>{a.icon}</span>
            <span>{a.msg}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ══════════════════════════════
   MAIN DASHBOARD
══════════════════════════════ */
export default function Dashboard() {
  const [txns, setTxns] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('dashboard')
  const [showAdd, setShowAdd] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .order('date', { ascending: false })
    if (!error) setTxns(data)
    setLoading(false)
  }

  const addTxn = (t) => setTxns(prev => [t, ...prev])

  const deleteTxn = async (id) => {
    await supabase.from('transactions').delete().eq('id', id)
    setTxns(prev => prev.filter(t => t.id !== id))
  }

  /* ── METRICS ── */
  const now = new Date()
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
  const inMonth = t => t.date.startsWith(curMonth)

  const curIncome  = txns.filter(t=>t.type==='income'  &&inMonth(t)).reduce((s,t)=>s+t.amount,0)
  const curExpense = txns.filter(t=>t.type==='expense' &&inMonth(t)).reduce((s,t)=>s+t.amount,0)
  const curProfit  = curIncome - curExpense
  const curRaw     = txns.filter(t=>t.category==='חומרי גלם'&&inMonth(t)).reduce((s,t)=>s+t.amount,0)
  const curLabor   = txns.filter(t=>t.category==='עובדים'  &&inMonth(t)).reduce((s,t)=>s+t.amount,0)
  const foodCostPct  = curIncome>0 ? curRaw/curIncome : 0
  const laborCostPct = curIncome>0 ? curLabor/curIncome : 0

  /* ── CHARTS DATA ── */
  const dailyMap = {}
  txns.filter(t=>t.type==='income').forEach(t=>{ dailyMap[t.date]=(dailyMap[t.date]||0)+t.amount })
  const dailyData = Object.entries(dailyMap).sort(([a],[b])=>a.localeCompare(b)).slice(-14)
    .map(([date,מכירות])=>({ date:date.slice(5), מכירות }))

  const expMap = {}
  txns.filter(t=>t.type==='expense').forEach(t=>{ expMap[t.category]=(expMap[t.category]||0)+t.amount })
  const pieData = Object.entries(expMap).sort(([,a],[,b])=>b-a).map(([name,value])=>({ name, value:Math.round(value) }))
  const totalExp = pieData.reduce((s,d)=>s+d.value,0)

  const profitMap = {}
  ;[...new Set(txns.map(t=>t.date))].forEach(d=>{
    const inc = txns.filter(t=>t.date===d&&t.type==='income').reduce((s,t)=>s+t.amount,0)
    const exp = txns.filter(t=>t.date===d&&t.type==='expense').reduce((s,t)=>s+t.amount,0)
    profitMap[d] = inc - exp
  })
  const profitData = Object.entries(profitMap).sort(([a],[b])=>a.localeCompare(b)).slice(-14)
    .map(([date,רווח])=>({ date:date.slice(5), רווח:Math.round(רווח) }))

  const kpis = [
    { label:'מחזור החודש', value:fmtK(curIncome), icon:'💰', accent:T.teal, sub:`${txns.filter(t=>t.type==='income'&&inMonth(t)).length} רשומות` },
    { label:'רווח נקי', value:fmtK(curProfit), icon:curProfit>=0?'📈':'📉', accent:curProfit>=0?T.green:T.red, sub:curIncome>0?fmtP(curProfit/curIncome)+' מהמחזור':'', subColor:curProfit>=0?T.green:T.red },
    { label:'Food Cost', value:fmtP(foodCostPct), icon:'🥗', accent:foodCostPct>0.32?T.red:T.amber, sub:foodCostPct>0.32?'⚠️ גבוה מהיעד':'✓ תקין', subColor:foodCostPct>0.32?T.red:T.green },
    { label:'עלות עובדים', value:fmtP(laborCostPct), icon:'👷', accent:laborCostPct>0.28?T.red:T.teal, sub:laborCostPct>0.28?'⚠️ גבוה':'✓ תקין', subColor:laborCostPct>0.28?T.red:T.green },
  ]

  const TABS = [
    { k:'dashboard', icon:'📊', label:'דשבורד' },
    { k:'log',       icon:'📋', label:'יומן' },
  ]

  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Heebo,sans-serif', background:T.bg }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🧆</div>
        <div style={{ color:T.sub }}>טוען נתונים...</div>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:T.bg, fontFamily:'Heebo,sans-serif', color:T.text, direction:'rtl', paddingBottom:isMobile?80:0 }}>

      {showAdd && <AddModal onAdd={addTxn} onClose={()=>setShowAdd(false)}/>}

      {/* ── HEADER ── */}
      <div style={{ background:`linear-gradient(135deg,${T.tealD},${T.teal})`, position:'sticky', top:0, zIndex:100, boxShadow:'0 2px 20px rgba(0,0,0,0.2)' }}>
        <div style={{ maxWidth:1400, margin:'0 auto', padding:isMobile?'0 14px':'0 24px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:isMobile?'10px 0':'14px 0 10px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <img src={`data:image/png;base64,${LOGO}`} alt="לוגו" style={{ width:isMobile?36:46, height:isMobile?36:46, objectFit:'contain', filter:'brightness(0) invert(1)' }}/>
              <div>
                <div style={{ fontWeight:900, fontSize:isMobile?15:19, color:'#fff', letterSpacing:-0.5 }}>פלאפל בתחנה</div>
                {!isMobile && <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)' }}>ניהול פיננסי חכם · Supabase Connected</div>}
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:isMobile?12:20 }}>
              {[
                { l:'מחזור', v:fmtK(curIncome), c:'#6EE7B7' },
                { l:'רווח',  v:fmtK(curProfit), c:curProfit>=0?'#6EE7B7':'#FCA5A5' },
              ].map(k=>(
                <div key={k.l} style={{ textAlign:'center' }}>
                  <div style={{ fontSize:9, color:'rgba(255,255,255,0.5)', letterSpacing:'0.08em' }}>{k.l}</div>
                  <div style={{ fontSize:isMobile?13:15, fontWeight:800, color:k.c, fontFamily:"'DM Mono',monospace" }}>{k.v}</div>
                </div>
              ))}
              <button onClick={()=>setShowAdd(true)} style={{ background:'rgba(255,255,255,0.2)', border:'1px solid rgba(255,255,255,0.3)', color:'#fff', padding:isMobile?'7px 12px':'8px 16px', borderRadius:10, fontSize:isMobile?12:13, fontWeight:600, cursor:'pointer', fontFamily:'Heebo,sans-serif' }}>
                + הוסף
              </button>
            </div>
          </div>
          {!isMobile && (
            <div style={{ display:'flex', gap:2, paddingTop:2 }}>
              {TABS.map(t=>(
                <button key={t.k} onClick={()=>setTab(t.k)} style={{ background:tab===t.k?'rgba(255,255,255,0.18)':'transparent', border:'none', color:'#fff', fontSize:13, padding:'10px 20px', cursor:'pointer', fontFamily:'Heebo,sans-serif', fontWeight:tab===t.k?700:400, borderBottom:tab===t.k?'3px solid #fff':'3px solid transparent' }}>{t.icon} {t.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── BODY ── */}
      <div style={{ maxWidth:1400, margin:'0 auto', padding:isMobile?'14px 12px':'24px 24px 40px' }}>

        {/* EMPTY STATE */}
        {txns.length===0 && (
          <Card style={{ textAlign:'center', padding:'40px 20px', marginBottom:20 }}>
            <div style={{ fontSize:50, marginBottom:12 }}>🧆</div>
            <div style={{ fontWeight:700, fontSize:18, color:T.text, marginBottom:8 }}>ברוך הבא לפלאפל בתחנה!</div>
            <div style={{ color:T.sub, fontSize:14, marginBottom:20 }}>התחל להוסיף תנועות כדי לראות את הדשבורד</div>
            <button onClick={()=>setShowAdd(true)} style={{ padding:'12px 24px', background:T.teal, color:'#fff', border:'none', borderRadius:12, fontSize:15, fontWeight:700, cursor:'pointer', fontFamily:'Heebo,sans-serif' }}>+ הוסף תנועה ראשונה</button>
          </Card>
        )}

        {/* DASHBOARD TAB */}
        {(tab==='dashboard'||isMobile&&tab==='dashboard') && txns.length>0 && (<>

          {/* KPIs */}
          <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)', gap:isMobile?10:16, marginBottom:isMobile?14:20 }}>
            {kpis.map((k,i)=><KpiCard key={i} {...k} isMobile={isMobile}/>)}
          </div>

          {/* AI Alerts */}
          <div style={{ marginBottom:isMobile?14:20 }}>
            <AIAlerts txns={txns}/>
          </div>

          {/* Charts */}
          <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr':'1fr 1fr', gap:isMobile?14:20, marginBottom:isMobile?14:20 }}>
            <Card>
              <CardTitle icon="📊" title="מכירות יומיות" sub="14 ימים אחרונים"/>
              {dailyData.length>0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={dailyData} margin={{top:4,right:4,left:0,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                    <XAxis dataKey="date" tick={{fill:T.sub,fontSize:10}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                    <YAxis tickFormatter={fmtK} tick={{fill:T.sub,fontSize:10}} axisLine={false} tickLine={false} width={50}/>
                    <Tooltip content={<CTip/>}/>
                    <Bar dataKey="מכירות" fill={T.teal} radius={[4,4,0,0]} maxBarSize={28}/>
                  </BarChart>
                </ResponsiveContainer>
              ) : <div style={{ textAlign:'center', padding:'40px 0', color:T.sub }}>אין נתוני מכירות עדיין</div>}
            </Card>

            <Card>
              <CardTitle icon="🥧" title="התפלגות הוצאות" sub="לפי קטגוריה"/>
              {pieData.length>0 ? (
                <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                  <ResponsiveContainer width={150} height={160}>
                    <PieChart>
                      <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={65} labelLine={false}
                        label={({percent})=>percent>0.08?`${(percent*100).toFixed(0)}%`:''}>
                        {pieData.map((_,i)=><Cell key={i} fill={T.chart[i%T.chart.length]}/>)}
                      </Pie>
                      <Tooltip formatter={v=>[fmt(v),'']}/> 
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ flex:1, display:'flex', flexDirection:'column', gap:6 }}>
                    {pieData.map((d,i)=>(
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:10, height:10, borderRadius:2, background:T.chart[i%T.chart.length], flexShrink:0 }}/>
                        <span style={{ fontSize:11, color:T.sub, flex:1 }}>{d.name}</span>
                        <span style={{ fontSize:11, fontWeight:600, color:T.text }}>{totalExp>0?((d.value/totalExp)*100).toFixed(0)+'%':'—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <div style={{ textAlign:'center', padding:'40px 0', color:T.sub }}>אין נתוני הוצאות עדיין</div>}
            </Card>
          </div>

          {/* Profit Trend */}
          {profitData.length>1 && (
            <Card style={{ marginBottom:isMobile?14:20 }}>
              <CardTitle icon="📈" title="רווח לאורך זמן" sub="רווח יומי — 14 ימים"/>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={profitData} margin={{top:4,right:4,left:0,bottom:0}}>
                  <defs>
                    <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={T.green} stopOpacity={0.2}/>
                      <stop offset="95%" stopColor={T.green} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
                  <XAxis dataKey="date" tick={{fill:T.sub,fontSize:10}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                  <YAxis tickFormatter={fmtK} tick={{fill:T.sub,fontSize:10}} axisLine={false} tickLine={false} width={54}/>
                  <Tooltip content={<CTip/>}/>
                  <Area type="monotone" dataKey="רווח" stroke={T.green} strokeWidth={2.5} fill="url(#gP)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>)}

        {/* LOG TAB */}
        {(tab==='log'||(isMobile&&tab==='log')) && (
          <Card>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <div>
                <div style={{ fontWeight:700, fontSize:15, color:T.text }}>📋 פירוט תנועות</div>
                <div style={{ fontSize:11, color:T.sub, marginTop:2 }}>{txns.length} רשומות</div>
              </div>
              <button onClick={()=>setShowAdd(true)} style={{ padding:'8px 16px', background:T.teal, color:'#fff', border:'none', borderRadius:10, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'Heebo,sans-serif' }}>+ הוסף</button>
            </div>

            {isMobile ? (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {txns.slice(0,50).map(t=>(
                  <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', background:T.bg, borderRadius:10 }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:t.type==='income'?T.green:T.red, flexShrink:0 }}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:T.text }}>{t.category}</div>
                      <div style={{ fontSize:10, color:T.sub }}>{t.date}</div>
                    </div>
                    <div style={{ fontWeight:700, color:t.type==='income'?T.green:T.red, fontFamily:"'DM Mono',monospace", fontSize:14 }}>
                      {t.type==='income'?'+':'-'}{fmtK(t.amount)}
                    </div>
                    <button onClick={()=>deleteTxn(t.id)} style={{ background:'none', border:'none', color:T.sub, fontSize:18, cursor:'pointer', padding:'0 4px' }}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#F8FAFC' }}>
                      {['תאריך','סוג','קטגוריה','סכום','הערה',''].map((h,i)=>(
                        <th key={i} style={{ padding:'9px 12px', textAlign:'right', color:T.sub, fontWeight:600, fontSize:11, borderBottom:`1px solid ${T.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {txns.slice(0,50).map((t,i)=>(
                      <tr key={t.id} style={{ background:i%2===0?T.card:T.bg, borderBottom:`1px solid ${T.border}` }}>
                        <td style={{ padding:'9px 12px', color:T.sub, fontFamily:"'DM Mono',monospace", fontSize:12 }}>{t.date}</td>
                        <td style={{ padding:'9px 12px' }}>
                          <span style={{ background:t.type==='income'?T.greenS:T.redS, color:t.type==='income'?T.green:T.red, fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20 }}>
                            {t.type==='income'?'הכנסה':'הוצאה'}
                          </span>
                        </td>
                        <td style={{ padding:'9px 12px', fontWeight:500, color:T.text }}>{t.category}</td>
                        <td style={{ padding:'9px 12px', fontWeight:700, color:t.type==='income'?T.green:T.red, fontFamily:"'DM Mono',monospace" }}>
                          {t.type==='income'?'+':'-'}{fmt(t.amount)}
                        </td>
                        <td style={{ padding:'9px 12px', color:T.sub, fontSize:12 }}>{t.note||'—'}</td>
                        <td style={{ padding:'9px 12px' }}>
                          <button onClick={()=>deleteTxn(t.id)} style={{ background:T.redS, border:'none', color:T.red, fontSize:11, padding:'3px 10px', borderRadius:6, cursor:'pointer' }}>מחק</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── MOBILE BOTTOM NAV ── */}
      {isMobile && (
        <div style={{ position:'fixed', bottom:0, left:0, right:0, background:T.card, borderTop:`1px solid ${T.border}`, display:'flex', zIndex:200, boxShadow:'0 -4px 24px rgba(0,0,0,0.1)' }}>
          {[...TABS, {k:'add',icon:'➕',label:'הוסף'}].map(t=>(
            <button key={t.k} onClick={()=>t.k==='add'?setShowAdd(true):setTab(t.k)}
              style={{ flex:1, padding:'10px 0 12px', background:'transparent', border:'none', cursor:'pointer', fontFamily:'Heebo,sans-serif', display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              <span style={{ fontSize:22 }}>{t.icon}</span>
              <span style={{ fontSize:10, fontWeight:tab===t.k?700:400, color:tab===t.k?T.teal:T.sub }}>{t.label}</span>
              {tab===t.k&&t.k!=='add'&&<div style={{ width:24, height:3, background:T.teal, borderRadius:2 }}/>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}