// Shop opening hours, evaluated in Asia/Jerusalem (never the customer's device clock).
// Schedule (S4-OPERATING-HOURS-01): Sunday–Thursday 10:30–19:00 (19:00 itself is closed). Friday and Saturday closed.
// Plus one-off full-day closures (SPECIAL_CLOSURES, Israel calendar dates). Pickup, delivery and parcels all use exactly
// these hours; they gate only NEW orders / payment starts — a payment already started completes normally.

const TIME_ZONE = 'Asia/Jerusalem'
export const OPEN_MINUTES = 10 * 60 + 30
export const CLOSE_MINUTES = 19 * 60
export const OPEN_TIME_LABEL = '10:30'
export const CLOSE_TIME_LABEL = '19:00'
const OPEN_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4]          // Sun–Thu

/** One-off full-day closures, by Israel calendar date (YYYY-MM-DD) → reason shown to customers. */
export const SPECIAL_CLOSURES: Readonly<Record<string, string>> = {
  '2026-10-27': 'יום הבחירות',
}

const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface IsraelClock { year: number; month: number; day: number; weekday: number; minutes: number }

function israelClock(now: Date): IsraelClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

/** Israel calendar date `addDays` from today, formatted like the existing UI (e.g. "27.9"). */
function israelDateLabel(clock: IsraelClock, addDays: number): string {
  const d = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + addDays))
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' })
}

/** The Israel calendar day `addDays` from today: ISO key, weekday. */
function israelDay(clock: IsraelClock, addDays: number): { key: string; weekday: number } {
  const d = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + addDays))
  return { key: d.toISOString().slice(0, 10), weekday: d.getUTCDay() }
}

const isOpenDay = (day: { key: string; weekday: number }): boolean => OPEN_WEEKDAYS.includes(day.weekday) && !(day.key in SPECIAL_CLOSURES)

/**
 * isOpen: ordering is open right now. nextOpen: when it reopens (Hebrew, with weekday + date + time; '' while open).
 * closureNote: the reason when TODAY is a special closure (e.g. 'יום הבחירות'), else ''.
 */
export function getBusinessStatus(now: Date = new Date()): { isOpen: boolean; nextOpen: string; closureNote: string } {
  const c = israelClock(now)
  const today = israelDay(c, 0)
  const closureNote = SPECIAL_CLOSURES[today.key] ?? ''

  if (isOpenDay(today) && c.minutes >= OPEN_MINUTES && c.minutes < CLOSE_MINUTES)
    return { isOpen: true, nextOpen: '', closureNote }

  if (isOpenDay(today) && c.minutes < OPEN_MINUTES) return { isOpen: false, nextOpen: `היום בשעה ${OPEN_TIME_LABEL}`, closureNote }
  for (let d = 1; d <= 31; d++) {
    const day = israelDay(c, d)
    if (!isOpenDay(day)) continue
    const label = `${HEBREW_WEEKDAYS[day.weekday]} ${israelDateLabel(c, d)}`
    return { isOpen: false, nextOpen: d === 1 ? `מחר (${label}) בשעה ${OPEN_TIME_LABEL}` : `${label} בשעה ${OPEN_TIME_LABEL}`, closureNote }
  }
  return { isOpen: false, nextOpen: '', closureNote }
}

export const isShopOpen = (now: Date = new Date()): boolean => getBusinessStatus(now).isOpen

/* ─── Israel calendar day as UTC instants (DST-safe) ─── */

/** Offset of Asia/Jerusalem from UTC at the given instant, in minutes (e.g. +180 in summer, +120 in winter). */
function israelOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(name)
  if (!m) return 0 // "GMT" exactly
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0)
  return m[1] === '-' ? -minutes : minutes
}

/** UTC instant of 00:00 Israel time on the given Israel calendar date. */
function israelMidnightUtc(year: number, month: number, day: number): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0)
  // Two passes converge even across DST changes (Israel switches at 02:00, never at midnight).
  let guess = naiveUtc - israelOffsetMinutes(new Date(naiveUtc)) * 60_000
  guess = naiveUtc - israelOffsetMinutes(new Date(guess)) * 60_000
  return new Date(guess)
}

/**
 * Start (inclusive) and end (exclusive) of TODAY in Israel, as UTC Dates — for queries like
 * created_at >= start AND created_at < end. Days around DST changes are 23h / 25h long, correctly.
 */
export function israelDayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const c = israelClock(now)
  const next = new Date(Date.UTC(c.year, c.month - 1, c.day + 1))
  return {
    start: israelMidnightUtc(c.year, c.month, c.day),
    end: israelMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  }
}
