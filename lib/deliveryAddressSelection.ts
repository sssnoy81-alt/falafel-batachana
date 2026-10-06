// Client-side Google address selection state for delivery checkout (FALAFEL-SN-08D8). Pure, client-safe.
// The browser only keeps what it shows; the server re-verifies the place id on submit (lib/orderAddress).
//
// Route-only selections (08D14D): Google verified the street but not the house. The customer types the house
// number (strictly validated) and the order additionally needs trusted device GPS — the route centre is never
// a delivery location.

import type { PlaceVerificationReason } from './googlePlaces'
import { extractHouseNumberHint, normalizeManualHouseNumber } from './houseNumber'

export interface SelectedDeliveryAddress {
  /** 'address' = Google street_address with a house number; 'route' = Google knows the street only. */
  kind: 'address' | 'route'
  placeId: string
  city: string          // the delivery area the selection was verified against
  street: string
  houseNumber: string   // Google's house number; '' for a route-only selection
  formattedAddress: string | null
}

export interface AddressPickerState {
  city: string
  query: string
  selected: SelectedDeliveryAddress | null
  /** Route-only selection: the house number the customer typed (raw; validated with normalizeManualHouseNumber). */
  manualHouseNumber: string
}

/** Text shown in the input after a selection ("הגעש 6"; route only: "הגעש"). */
export const selectionQueryText = (s: SelectedDeliveryAddress): string =>
  s.kind === 'route' ? s.street : `${s.street} ${s.houseNumber}`
/** Human-readable confirmation ("הגעש 6, מעלה אדומים"; route only: "הגעש, מעלה אדומים"). */
export const selectionLabel = (s: SelectedDeliveryAddress): string =>
  s.kind === 'route' ? `${s.street}, ${s.city}` : `${s.street} ${s.houseNumber}, ${s.city}`

/** Changing the delivery area clears the selection, the typed query and any manual house number. */
export const withCity = (_state: AddressPickerState, city: string): AddressPickerState =>
  ({ city, query: '', selected: null, manualHouseNumber: '' })

/** Editing the text after a selection invalidates it (unless the text is unchanged). */
export const withQuery = (state: AddressPickerState, query: string): AddressPickerState =>
  state.selected && query === selectionQueryText(state.selected) ? state
    : { ...state, query, selected: null, manualHouseNumber: '' }

/** Accepting a server-verified selection for the current area. Route only: the typed number is a PREFILL only. */
export const withSelection = (state: AddressPickerState, selected: SelectedDeliveryAddress): AddressPickerState =>
  selected.city === state.city
    ? { ...state, selected, query: selectionQueryText(selected), manualHouseNumber: selected.kind === 'route' ? extractHouseNumberHint(state.query) : '' }
    : { ...state, selected: null, manualHouseNumber: '' }

/** Typing the house number for a route-only selection (ignored otherwise). */
export const withManualHouseNumber = (state: AddressPickerState, value: string): AddressPickerState =>
  state.selected?.kind === 'route' ? { ...state, manualHouseNumber: value } : state

const selectedForArea = (state: AddressPickerState): SelectedDeliveryAddress | null =>
  state.selected && state.selected.city === state.city && state.selected.placeId !== '' && state.selected.street.trim() !== ''
    ? state.selected : null

/** The house number checkout sends: Google's, or the validated manual one for a route-only selection ('' if none). */
export function selectionHouseNumber(state: AddressPickerState): string {
  const s = selectedForArea(state)
  if (!s) return ''
  return s.kind === 'route' ? normalizeManualHouseNumber(state.manualHouseNumber) ?? '' : s.houseNumber.trim()
}

/** A complete textual address: verified selection for the current area + a house number (Google's or valid manual). */
export const isAddressSelectionValid = (state: AddressPickerState): boolean =>
  !!selectedForArea(state) && selectionHouseNumber(state) !== ''

/** Route-only selection: the order additionally needs trusted device GPS (never the route centre). */
export const requiresPreciseLocation = (state: AddressPickerState): boolean => selectedForArea(state)?.kind === 'route'

/** Delivery address ready for submit: full Google address, or route-only + valid number + trusted GPS. */
export const isDeliveryAddressReady = (state: AddressPickerState, hasTrustedLocation: boolean): boolean =>
  isAddressSelectionValid(state) && (!requiresPreciseLocation(state) || hasTrustedLocation)

export const ADDRESS_REJECTION_MESSAGES: Readonly<Record<PlaceVerificationReason | 'place_not_found' | 'unknown', string>> = {
  city_mismatch: 'הכתובת שנבחרה אינה תואמת ליישוב המשלוח',
  missing_street: 'יש לבחור כתובת מלאה עם שם רחוב',
  missing_house_number: 'יש לבחור כתובת עם מספר בית',
  invalid_coordinates: 'לא ניתן לאמת את מיקום הכתובת. נסו כתובת אחרת',
  invalid_address: 'לא ניתן לאמת את הכתובת. נסו כתובת אחרת',
  place_not_found: 'הכתובת לא נמצאה. נסו לבחור שוב מהרשימה',
  unknown: 'לא ניתן לאמת את הכתובת. נסו שוב',
}

export const ROUTE_ONLY_MESSAGES = {
  streetFound: '✅ הרחוב נמצא',
  enterHouseNumber: 'Google לא זיהה את מספר הבית. הזינו מספר בית.',
  invalidHouseNumber: 'מספר בית לא תקין (לדוגמה: 3 או 12א)',
  needsLocation: 'יש לנו כתובת, אבל צריך מיקום מדויק למשלוח.',
  notAtAddress: 'Google לא הצליח לאתר את מספר הבית במפה. אם אינך נמצא כרגע בכתובת, לא ניתן לאמת את המיקום המדויק.',
  ready: '✅ הכתובת והמיקום נקלטו',
} as const
