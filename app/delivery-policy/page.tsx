import type { Metadata } from 'next'
import LegalPage from '../_components/LegalPage'
import { ACTIVE_DELIVERY_AREAS, getDeliveryFeeForArea } from '@/lib/orderConfig'

export const metadata: Metadata = { title: 'מדיניות משלוחים | פלאפל בתחנה' }

// Areas + fees come from the same server config checkout charges from, so this page can't drift from pricing.
const AREA_LINES = ACTIVE_DELIVERY_AREAS.map(a => `${a} — דמי משלוח: ${getDeliveryFeeForArea(a)} ₪`)

export default function DeliveryPolicyPage() {
  return (
    <LegalPage title="מדיניות משלוחים – פלאפל בתחנה">
      <p>פלאפל בתחנה מספקת שירות משלוחים באזורים שבהם השירות זמין במערכת ההזמנות.</p>
      <p>נכון לעכשיו, אזורי המשלוח הפעילים הם:</p>
      <ul>{AREA_LINES.map(line => <li key={line}>{line}</li>)}</ul>
      <p>ייתכן שאזורים נוספים יתווספו או יוסרו מעת לעת בהתאם לזמינות השירות.</p>
      <p>המשלוחים מבוצעים מסניף מישור אדומים בלבד.</p>
      <p>בעת ביצוע ההזמנה על הלקוח למסור כתובת מלאה ומדויקת, לרבות יישוב, רחוב ומספר בית. במידת הצורך, המערכת עשויה לבקש גם פרטי מיקום כדי לאפשר הגעה מדויקת של השליח.</p>
      <p>זמן האספקה עשוי להשתנות בהתאם לעומס, זמינות שליחים, תנאי דרך, מזג אוויר ונסיבות תפעוליות נוספות. זמן המשלוח המוצג, ככל שמוצג, הוא הערכה בלבד.</p>
      <p>פלאפל בתחנה אינה אחראית לעיכוב שנגרם עקב פרטים שגויים שנמסרו על ידי הלקוח, חוסר מענה בטלפון, קושי בגישה לכתובת או נסיבות שאינן בשליטת העסק.</p>
      <p>במקרה שבו לא ניתן לבצע את המשלוח לכתובת שנמסרה, העסק רשאי ליצור קשר עם הלקוח לצורך בירור, שינוי או ביטול ההזמנה.</p>
      <p>דמי המשלוח מוצגים ללקוח לפני אישור ההזמנה ומהווים חלק מסכום ההזמנה הכולל.</p>
      <p>שעות המשלוחים כפופות לשעות הפעילות של העסק ולזמינות שירות המשלוחים באותו זמן.</p>
    </LegalPage>
  )
}
