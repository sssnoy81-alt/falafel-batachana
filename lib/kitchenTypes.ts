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
}

export interface KitchenOrderItem { id: string; name: string; quantity: number; notes: string | null }

export interface KitchenDelivery {
  address: string
  courierNotes: string | null
  mealQuantity: number
  mealSurcharge: number
  deliveryFee: number
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
}
