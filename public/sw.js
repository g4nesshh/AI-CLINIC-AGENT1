// ClinicAI Service Worker
// Handles push notifications and offline caching

const CACHE_NAME = 'clinicai-v1'
const CACHE_URLS = ['/', '/chat.html', '/admin.html']

// Install — cache key pages
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  )
  self.skipWaiting()
})

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Fetch — serve from cache when offline
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  )
})

// Push notification received
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {}

  const title   = data.title   || 'ClinicAI'
  const body    = data.body    || 'You have a new notification'
  const icon    = data.icon    || '/icon-192.png'
  const badge   = data.badge   || '/icon-192.png'
  const url     = data.url     || '/'
  const tag     = data.tag     || 'clinicai-notification'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: { url },
      actions: [
        { action: 'open',    title: 'View'    },
        { action: 'dismiss', title: 'Dismiss' }
      ],
      requireInteraction: data.urgent || false
    })
  )
})

// Notification clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'dismiss') return

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})