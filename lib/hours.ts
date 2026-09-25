// Shop opening hours, evaluated in Asia/Jerusalem (never the customer's device clock).
// Schedule (unchanged): Sunday–Thursday 08:00–19:30. Friday and Saturday closed.
// Delivery uses exactly the same hours.

const TIME_ZONE = 'Asia/Jerusalem'
const OPEN_MINUTES = 8 * 60
const CLOSE_MINUTES = 19 * 60 + 30

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

export function getBusinessStatus(now: Date = new Date()): { isOpen: boolean; nextOpen: string } {
  const c = israelClock(now)
  const isFri = c.weekday === 5
  const isSat = c.weekday === 6

  if (!isFri && !isSat && c.minutes >= OPEN_MINUTES && c.minutes < CLOSE_MINUTES)
    return { isOpen: true, nextOpen: '' }

  let nextOpen: string
  if (isSat) {
    nextOpen = `ראשון ${israelDateLabel(c, 1)} בשעה 08:00`
  } else if (isFri) {
    nextOpen = `ראשון ${israelDateLabel(c, 2)} בשעה 08:00`
  } else if (c.minutes < OPEN_MINUTES) {
    nextOpen = 'היום בשעה 08:00'
  } else if (c.weekday === 4) {
    nextOpen = `ראשון ${israelDateLabel(c, 3)} בשעה 08:00`
  } else {
    nextOpen = 'מחר בשעה 08:00'
  }
  return { isOpen: false, nextOpen }
}

export const isShopOpen = (now: Date = new Date()): boolean => getBusinessStatus(now).isOpen
