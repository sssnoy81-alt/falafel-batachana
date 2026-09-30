import { notFound } from 'next/navigation'
import { isAddressPocEnabled } from '@/lib/googlePlaces'
import { DELIVERY_AREAS } from '@/lib/orderConfig'
import AddressPocClient from './AddressPocClient'

// /dev/address-poc — DEVELOPER-ONLY Google Places address POC (FALAFEL-SN-08D7). Not linked from the app.
// 404 unless ADDRESS_POC_ENABLED=true and not Vercel Production.
export const dynamic = 'force-dynamic'

export default function AddressPocPage() {
  if (!isAddressPocEnabled(process.env)) notFound()
  return <AddressPocClient areas={[...DELIVERY_AREAS]} />
}
