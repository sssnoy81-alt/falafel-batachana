self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {}
  const title = data.title || 'פלאפל בתחנה'
  const options = {
    body: data.body || 'ההזמנה שלך מוכנה!',
    icon: 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg',
    badge: 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg',
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,
    dir: 'rtl',
    lang: 'he',
    data: data,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', function(event) {
  event.notification.close()
  event.waitUntil(clients.openWindow('/'))
})