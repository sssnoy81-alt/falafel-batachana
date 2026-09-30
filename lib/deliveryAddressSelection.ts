// Client-side Google address selection state for delivery checkout (FALAFEL-SN-08D8). Pure, client-safe.
// The browser only keeps what it shows; the server re-verifies the place id on submit (lib/orderAddress).

import type { PlaceVerificationReason } from './googlePlaces'

export interface SelectedDeliveryAddress {
  placeId: string
  city: string          // the delivery area the selection was verified against
  street: string
  houseNumber: string
  formattedAddress: string | null
}

export interface AddressPickerState {
  city: string
  query: string
  selected: SelectedDeliveryAddress | null
}

/** Text shown in the input after a selection ("הגעש 6"). */
export const selectionQueryText = (s: SelectedDeliveryAddress): string => `${s.street} ${s.houseNumber}`
/** Human-readable confirmation ("הגעש 6, מעלה אדומים"). */
export const selectionLabel = (s: SelectedDeliveryAddress): string => `${s.street} ${s.houseNumber}, ${s.city}`

/** Changing the delivery area clears the selection and the typed query (a new selection is required). */
export const withCity = (_state: AddressPickerState, city: string): AddressPickerState => ({ city, query: '', selected: null })

/** Editing the text after a selection invalidates it (unless the text is unchanged). */
export const withQuery = (state: AddressPickerState, query: string): AddressPickerState =>
  state.selected && query === selectionQueryText(state.selected) ? state : { ...state, query, selected: null }

/** Accepting a server-verified selection for the current area. */
export const withSelection = (state: AddressPickerState, selected: SelectedDeliveryAddress): AddressPickerState =>
  selected.city === state.city ? { ...state, selected, query: selectionQueryText(selected) } : { ...state, selected: null }

/** Delivery can be submitted only with a verified selection for the currently selected area. */
export const isAddressSelectionValid = (state: AddressPickerState): boolean =>
  !!state.selected && state.selected.city === state.city
  && state.selected.street.trim() !== '' && state.selected.houseNumber.trim() !== '' && state.selected.placeId !== ''

export const ADDRESS_REJECTION_MESSAGES: Readonly<Record<PlaceVerificationReason | 'place_not_found' | 'unknown', string>> = {
  city_mismatch: 'הכתובת שנבחרה אינה תואמת ליישוב המשלוח',
  missing_street: 'יש לבחור כתובת מלאה עם שם רחוב',
  missing_house_number: 'יש לבחור כתובת עם מספר בית',
  invalid_coordinates: 'לא ניתן לאמת את מיקום הכתובת. נסו כתובת אחרת',
  invalid_address: 'לא ניתן לאמת את הכתובת. נסו כתובת אחרת',
  place_not_found: 'הכתובת לא נמצאה. נסו לבחור שוב מהרשימה',
  unknown: 'לא ניתן לאמת את הכתובת. נסו שוב',
}
