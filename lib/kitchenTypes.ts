// Kitchen API contract types — shared by the server routes and the kitchen UI.
// Types only: no imports, no runtime code, safe for client components.

export type KitchenRole = 'admin' | 'branch'

export interface KitchenPublicUser {
  username: string
  role: KitchenRole
  branchId: string | null
  label: string
}

export interface KitchenBranch { id: string; name: string }

/** GET /api/kitchen/session */
export interface KitchenSessionResponse {
  user: KitchenPublicUser
  expiresAt: string
  branches: KitchenBranch[] // admin only; [] for branch users
  /** Manual Maale Express courier requests (S4-03M / 04C): true only when the feature flag is on AND THIS account is
   *  in the server-side allowlist. Derived per session; the allowlist itself is never sent. */
  maaleKitchenDispatchEnabled: boolean
}

export type KitchenDispatchView = 'not_dispatched' | 'in_progress' | 'sent' | 'rate_limited_manual_check' | 'needs_manual_check' | 'failed'

/** Courier request state of a delivery order (delivery_dispatches row). Present only while kitchen dispatch is enabled. */
export interface KitchenDispatch {
  view: KitchenDispatchView
  errorCode: string | null       // short internal code (e.g. 'timeout'); never a provider body
  providerOrderId: string | null
  providerStatus: string | null
}

export interface KitchenOrderItem { id: string; name: string; quantity: number; notes: string | null }

export interface KitchenDelivery {
  address: string
  courierNotes: string | null
  mealQuantity: number
  mealSurcharge: number
  deliveryFee: number
}

/** Parcel attached to a delivery order (GATE 03H). Kitchen-only: never part of any customer-facing response. */
export interface KitchenParcel {
  status: string          // parcel_requests.status (independent of the food order status)
  trackingRef: string     // as entered by the customer — shown to authorized kitchen staff only
  carrier: string | null
  recipientName: string | null // name printed on the parcel (Migration 05); null → identify by the order's customer name
}

/** One element of GET /api/kitchen/orders → { orders: KitchenOrder[] } */
export interface KitchenOrder {
  id: string
  dailyNumber: number | null
  type: 'pickup' | 'delivery'
  status: string
  createdAt: string
  customerName: string | null
  phone: string
  paymentMethod: string
  totalPrice: number
  branchId: string
  branchName: string | null
  items: KitchenOrderItem[]
  delivery: KitchenDelivery | null
  parcel: KitchenParcel | null // delivery orders only; null when no parcel was requested
  /** Only when kitchen dispatch is enabled (key absent otherwise); null = no courier request yet / not a delivery. */
  dispatch?: KitchenDispatch | null
}
