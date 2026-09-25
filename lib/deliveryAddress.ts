// Structured delivery address + formatter for deliveries.address.

export interface DeliveryAddress {
  city: string
  street: string
  houseNumber: string
  apartment?: string
  floor?: string
  entrance?: string
  courierNotes?: string
}

const clean = (s: string | null | undefined): string => (s ?? '').trim()

/** e.g. "מעלה אדומים, הדקל 12, כניסה ב, קומה 3, דירה 8" — empty optional parts are skipped. */
export function formatDeliveryAddress(a: Pick<DeliveryAddress, 'city' | 'street' | 'houseNumber' | 'apartment' | 'floor' | 'entrance'>): string {
  const streetLine = [clean(a.street), clean(a.houseNumber)].filter(Boolean).join(' ')
  return [
    clean(a.city),
    streetLine,
    clean(a.entrance) && `כניסה ${clean(a.entrance)}`,
    clean(a.floor) && `קומה ${clean(a.floor)}`,
    clean(a.apartment) && `דירה ${clean(a.apartment)}`,
  ].filter(Boolean).join(', ')
}
