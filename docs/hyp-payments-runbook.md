# Runbook — תשלום מקוון (Hyp Pay): שחרור, התקנה ופיילוט

> מסמך תפעולי. **לא** מכיל ואסור שיכיל ערכי credentials. ערכים אמיתיים מוזנים רק ב-Vercel ובפורטל HYP.
> כל צעד שמסומן 🔐 דורש אישור מפורש של הבעלים לפני ביצוע.

## 0. מצב ברירת מחדל אחרי השחרור

| משתנה | ערך בשחרור | משמעות |
|---|---|---|
| `HYP_PAYMENTS_ENABLED` | **לא מוגדר** (או `false`) | אפשרות התשלום המקוון מוסתרת; `start` מחזיר 404; הקופה הרגילה זהה לחלוטין |
| `HYP_STAFF_RECOVERY_ENABLED` | **לא מוגדר** | פעולות צוות על תשלומים כבויות (404); לשונית "תשלומים" לקריאה בלבד |

כל הדגלים נכשלים סגור: רק המחרוזת המדויקת `true` מפעילה.

## 1. בדיקות מקומיות לפני שחרור (חובה, כולן ירוקות)

```
node scripts/pgtest-hyp05-payment-intents.mjs      # DB מבודד (Docker, --network none)
node scripts/pgtest-hyp07-payment-flow.mjs          # E2E על SQL אמיתי + שחזור צוות
node scripts/verify-hyp-client.mjs
node scripts/verify-hyp-routes.mjs
node scripts/verify-hyp-ui.mjs
node scripts/verify-hyp-recovery.mjs
for f in scripts/verify-*.mjs; do node "$f" || echo "FAIL $f"; done   # (מלבד verify-maale-dry-run-once.mjs)
npx tsc --noEmit -p .
npx eslint lib/hyp app/api/payments app/api/kitchen/payments app/order/payment app/dashboard/orders/PaymentsTab.tsx
NEXT_TELEMETRY_DISABLED=1 npx next build
```

## 2. 🔐 מסד הנתונים ב-Production (Supabase SQL Editor, role postgres, מחוץ לשעות הפעילות)

קבצים ב-`db/migrations/` — לוודא SHA-256 לפני כל הרצה (`Get-FileHash -Algorithm SHA256 <file>`):

| קובץ | SHA-256 |
|---|---|
| `hyp05_production_preflight.sql` | `71ecd5c4980e726c8c93846d9bae64a103d736fe9331b7a44a2c095b2ca62cea` |
| `hyp05_privilege_audit.sql` | `58d7a01d449700a0f909b8c06da24213724a873fb175bbc88a81a0f62a339002` |
| `hyp05_payment_intents.sql` | `5a7b502681fd11d2d77aeb511ff3573ce958e34c588ba5891f343b58ef082b0f` |
| `hyp05_verify.sql` | `b130b09f8dcdcc29dd5890e756ea82018a7b7a0f130934e4cb5486e5d0203ed6` |
| `hyp05_rollback.sql` | `c461273b6a0e88bd7e6c6bd4bc4b3ba976bb52532f16700f4b464a6c306415cb` |

בכל הרצה: Query חדש וריק → הדבקת הקובץ המלא (`Get-Content -Raw <file> \| Set-Clipboard`) → בלי סימון טקסט → Result limit = **No limit** → Run פעם אחת → ייצוא CSV.

| שלב | קובץ | תוצאה נדרשת | אם לא |
|---|---|---|---|
| 1 | `hyp05_production_preflight.sql` | 12 PASS + 2 INFO | **עצירה.** FAIL בשורה 12 = לתפקידים ציבוריים יש הרשאה על נתוני הזמנות → SEC-2 לפני הכול |
| 2 | `hyp05_privilege_audit.sql` | כל השורות PASS, ושורות `payment_*` = INFO ("not installed") | **עצירה** ובדיקה |
| 3 | `hyp05_payment_intents.sql` | `COMMIT` בלי שגיאה | השגיאה מבטלת הכול (טרנזקציה אחת). `lock_timeout` → להריץ שוב מאוחר יותר. כל שגיאה אחרת → לא להריץ שוב; לשלוח את הודעת השגיאה |
| 4 | `hyp05_verify.sql` | 17 PASS + 1 INFO | לא לפרוס קוד שמשתמש ב-HYP; לפנות לבדיקה |
| 5 | `hyp05_privilege_audit.sql` | **כל 33 השורות PASS** | כמו 4 |

**מה משתנה ב-Production בהתקנה:** תפקיד חדש `hyp_payment_coordinator`; 5 טבלאות `payment_*` חדשות (ריקות); 7 פונקציות + 5 פונקציות trigger חדשות; ב-`orders`: הערך `online` נוסף ל-`orders_payment_method_check` ושני triggers מסוג AFTER שפועלים **רק** על שורות `online`. **לא משתנים:** גוף/חתימה של `create_order` ו-`create_order_with_parcel` (שורה 09 ב-verify), שום שורה קיימת, הרשאות service_role על טבלאות קיימות, Maale, חבילות, מטבח. נעילת ACCESS EXCLUSIVE קצרה על `orders` בזמן החלפת ה-CHECK.

**בדיקת פונקציונליות קיימת אחרי ההתקנה (קריאה בלבד / בלי הזמנה אמיתית):** שורה 09 ב-verify (טביעות `create_order`); לוח המטבח נטען (`/dashboard/orders`); לשונית "💳 תשלומים" מציגה "אין תשלומים שדורשים טיפול". בדיקת הזמנת מזומן אמיתית — רק בפתיחת יום ראשון, בהחלטת הבעלים, וביטולה מהמטבח.

**Rollback / containment:** (א) ראשי — `HYP_PAYMENTS_ENABLED` כבוי + Redeploy (או Instant Rollback). (ב) DB — `hyp05_rollback.sql` רק באישור, רק בצירוף `SET hyp05.confirm_rollback = 'DROP-PAYMENT-INTENTS';` באותו session, והוא **מסרב** אם קיימת הזמנת online, חזרה מ-HYP, עסקה או intent מעבר ל-created/not_sent. ראיות כספיות לעולם לא נמחקות.

## 3. 🔐 פריסת קוד (Vercel)

1. Commit + PR + Merge ל-`main` (באישור) → פריסת Production אוטומטית, **בלי** משתני HYP.
2. אחרי הפריסה: `GET /api/payments/config` → `{"hypPayments":null}`; `/order` — אין אפשרות "תשלום מאובטח בכרטיס אשראי"; `POST /api/payments/hyp/start` → 404; `/api/kitchen/payments` (מחובר) → `available: true` (אחרי שלב 2).
3. אם שלב 2 לא בוצע: הלשונית מציגה "מודול התשלומים המקוונים אינו מותקן" — תקין; שום זרימה קיימת לא תלויה בו.

## 4. משתני סביבה ב-Vercel (שמות בלבד — ערכים מוזנים רק ב-Vercel, Production scope)

| משתנה | מתי | ערך / פורמט |
|---|---|---|
| `HYP_TERMINAL` | פיילוט | מספר מסוף (Masof); בדיקות מתחיל ב-`00100` |
| `HYP_API_KEY` | פיילוט | KEY מהפורטל |
| `HYP_PASSP` | פיילוט | PassP מהפורטל |
| `HYP_TERMINAL_KIND` | פיילוט | `test` או `live` — חייב להתאים לקידומת `00100`; `live` נחסם מחוץ ל-`VERCEL_ENV=production` |
| `HYP_PILOT_PHONES` | פיילוט מבוקר | רשימת טלפונים `05XXXXXXXX` מופרדת בפסיקים; רק הם יכולים להתחיל תשלום. **להשאיר מוגדר בכל שלב הבדיקות** |
| `HYP_PAYMENTS_ENABLED` | אחרון | `true` רק אחרי שכל השאר מוכן; כל ערך אחר = כבוי |
| `HYP_STAFF_RECOVERY_ENABLED` | לפני הפיילוט | `true` כדי לאפשר פעולות צוות |
| `HYP_STAFF_RECOVERY_USERS` | לפני הפיילוט | שמות משתמשי מטבח מסוג **admin** בלבד, מופרדים בפסיקים |

לעולם לא `NEXT_PUBLIC_*` לאף משתנה HYP (הקוד מסרב לעבוד אם קיים כזה). שינוי משתנה ב-Vercel נכנס לתוקף רק בפריסה הבאה (Redeploy).

## 5. הגדרות בפורטל HYP (לפני הפיילוט)

| הגדרה | ערך נדרש |
|---|---|
| מסוף / Masof | מסוף בדיקות (`00100…`) לשלב הראשון; מסוף אמיתי רק אחריו |
| KEY / PassP | מהפורטל → Vercel בלבד |
| **אימות על ידי חתימה בעמודי התשלום** | **חייב להיות מופעל** (תנאי מתועד ל-VERIFY) |
| כתובת חזרה (הצלחה) | `https://<הדומיין של Production>/api/payments/hyp/return` |
| כתובת כישלון / ביטול (אם קיימת בנפרד) | אותה כתובת (השרת מבחין לפי VERIFY) — **לאמת מול HYP** |
| מצב חיוב | חיוב רגיל (J4) — **לא** J5 / Postpone כברירת מחדל במסוף (אחרת כל תשלום יגיע כ"לא נגבה") |
| מטבע | ש"ח (`Coin=1`) |
| תשלומים | 1 (`Tash=1`) |
| שדות לקוח (ת"ז, שם) | לא נדרשים — **לאמת** שהמסוף לא מחייב אותם (קוד 401) |

## 6. 🔐 פיילוט (יום ראשון) — סדר מחייב

1. מסוף **בדיקות**, `HYP_TERMINAL_KIND=test`, `HYP_PILOT_PHONES=<טלפון הבעלים>`, `HYP_STAFF_RECOVERY_*` מוגדרים, ואז `HYP_PAYMENTS_ENABLED=true` → Redeploy.
2. בשעות הפתיחה, מטלפון הבעלים: הזמנת איסוף במישור אדומים → "תשלום מאובטח בכרטיס אשראי" → כרטיס הבדיקה של HYP → חזרה → "התשלום אושר וההזמנה התקבלה" → ההזמנה מופיעה במטבח עם "שולם אונליין ✓".
3. לאמת שהחזרה האמיתית עברה: אם מופיע "בבדיקה" / "לא ידוע" — לבדוק בלשונית התשלומים את הקוד (`reserved_field:Masof`, `unparseable` וכד') ולעצור.
4. ניסיון כרטיס נדחה (כרטיס הכישלון של HYP) → "התשלום לא הושלם", אין הזמנה.
5. רק אחרי הצלחה: מסוף **אמיתי** (`HYP_TERMINAL_KIND=live`), עדיין עם `HYP_PILOT_PHONES` → עסקה אחת קטנה של הבעלים → ביטול בפורטל באותו יום (לפני 22:00) → רישום "ביטול שכבר בוצע בפורטל" בלשונית.
6. פתיחה ללקוחות = הסרת `HYP_PILOT_PHONES` — החלטה נפרדת.

**עצירת חירום:** `HYP_PAYMENTS_ENABLED` למחוק → Redeploy. תשלומים שכבר אומתו לא הולכים לאיבוד: הם נשארים בלשונית "תשלומים" ("שולם — ההזמנה טרם נוצרה") ונשלחים למטבח ידנית.

## 7. התאמה יומית (חובה בזמן הפיילוט)

לשונית "💳 תשלומים" ריקה בסוף היום, וכל עסקה מאושרת בדוח HYP תואמת להזמנה עם "שולם אונליין ✓" (לפי מספר ההפניה = HYP Order). תשלום שנרשם במערכת ואינו בדוח HYP = חקירה מיידית.

## 8. נוהל שחזור לצוות (לשונית "💳 תשלומים", admin מורשה בלבד)

| מצב | פעולה |
|---|---|
| שולם — אין הזמנה / נכשלה יצירה / חזרה מאוחרת | לוודא מול הלקוח → "שליחת ההזמנה למטבח" |
| לא התקבלה חזרה / אימות נכשל | לחפש את ההפניה בפורטל: נמצא חיוב → "אישור תשלום שנמצא בפורטל" (Id + סכום) → ואז "שליחה למטבח"; לא נמצא → "לא נמצא חיוב" |
| אישור ללא חיוב (J5 / דחוי) | בפורטל: לשחרר / לבטל את המסגרת → "לא נמצא חיוב" |
| חיוב כפול | שליחה למטבח (עם אישור החיוב הכפול) → "נדרש זיכוי" → זיכוי בפורטל → "רישום זיכוי שכבר בוצע" עם האסמכתא |
| סכום שונה | ביטול / זיכוי בפורטל → רישום עם האסמכתא |

המערכת **לעולם** לא מבצעת זיכוי או ביטול בעצמה; רישום זיכוי דורש אסמכתא מהפורטל, וכל אסמכתא נרשמת פעם אחת בלבד.
