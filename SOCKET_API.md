# SOCKET_API — Home Services Real-Time Layer (HS3)

Socket.io is attached to the HTTP server in `src/server.js` (never the Express app).
Implementation: `src/sockets/{index,chatHandler,trackingHandler,lastLocationStore}.js`.

## Deployment note

The production Vercel deployment is serverless — WebSockets do not work there.
**Every socket event below has a REST fallback**, so the app degrades to
polling on Vercel; run the backend locally (`npm run dev`) or on any
long-lived socket-capable host for the live real-time demo.

## Connection & auth

```js
const socket = io(BASE_HOST, { auth: { token: '<JWT access token>' } });
```

- JWT is verified in `io.use()` with the same secret and User/Provider lookup
  as `src/middleware/authMiddleware.js`. Unauthenticated connections are
  rejected outright (`connect_error: Authentication required/failed`).
- `socket.user` + `socket.userRole` (`user` | `provider`) are attached server-side.

## Rooms

Convention: `booking:<bookingId>`. Clients never join rooms directly — they emit
`join_booking` and the server verifies the socket user is that booking's
customer or assigned provider **before** joining. Client-supplied room names
are never trusted.

| Event (client → server) | Payload | Ack | Auth |
|---|---|---|---|
| `join_booking` | `{ bookingId }` | `{ success, message? }` | participant of the booking |
| `leave_booking` | `{ bookingId }` | — | — |

## Chat (FR-10)

Model: `HSChatMessage { booking, sender, senderRole, text ≤2000, attachments[], readAt }`,
indexed `{ booking, createdAt }`.

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `send_message` | client → server | `{ bookingId, text }` (ack `{ success, data }`) | persists, then broadcasts `new_message`; room membership required |
| `new_message` | server → room | `{ id, text, sender: 'user'\|'provider', timestamp, status }` | matches frontend `ChatMessage` |
| `mark_read` | client → server | `{ bookingId }` | marks the other side's messages read, broadcasts `messages_read` |
| `messages_read` | server → room | `{ bookingId, readerRole }` | |
| `typing` | client → server | `{ bookingId, isTyping }` | relayed to the room as `typing { bookingId, role, isTyping }` |

REST fallback: `GET /api/chat/:bookingId` (ChatData history) ·
`POST /api/chat/:bookingId/messages { message }`.

## Live tracking (FR-09)

| Event | Direction | Payload | Rules |
|---|---|---|---|
| `provider_location` | provider → server | `{ bookingId, lat, lng, heading? }` (ack) | **provider only**, only while booking is `EN_ROUTE` or `ARRIVED` — rejected otherwise; membership + assignment verified |
| `provider_location_update` | server → room | `{ bookingId, latitude, longitude, heading, timestamp }` | |

- **Throttle:** at most one accepted update per booking per **3 s**, server-side.
- **NFR-08 — no retention:** positions live only in an in-memory map
  (`lastLocationStore.js`), are overwritten in place, and are cleared when the
  booking leaves `EN_ROUTE/ARRIVED`. Location history is **never** written to
  the database, so there is nothing to delete after job completion.

REST fallback: `GET /api/bookings/:bookingId/tracking` (TrackingData; the last
live position, or `providerLocation: null` — never the provider's stored service
base, which would present an area they work from as where they are now) ·
`POST /api/provider/location { latitude, longitude, jobId }`.

**"About 5 minutes away":** when a live position comes within ~2 km (≈5 min at
the configured urban speed) the realtime service calls the main API
(`POST /api/internal/homeservice/bookings/:bookingId/nearby`), which claims
`notifications.nearbyAt` atomically and sends the push + room event exactly once.

## Booking lifecycle fan-out

| Event | Direction | Payload |
|---|---|---|
| `booking_status_changed` | server → room | `{ bookingId, status: <canonical>, changedAt }` |
| `payment_requested` | server → room | `{ bookingId, amount }` |
| `payment_received` | server → room | the customer paid (wallet) |
| `payment_status_changed` | server → room | `{ bookingId, status: 'cash_selected' }` — the customer chose cash |
| `provider_nearby` | server → room | `{ bookingId, etaMinutes, distanceMeters }` — once per trip |
| `identity_verified` | server → room | `{ bookingId, method: 'nfc'\|'qr'\|'code', verifiedAt }` — the customer checked the provider's ID at the door |

Emitted from `bookingService.transition()` and the payment controller, so both
apps update live without polling. (No-ops when the socket layer isn't attached
— REST polling still works.)

## Push notifications

The main API never talks to FCM directly: it posts `{ userId, role, type, title, body, data }`
to the realtime service (`POST /api/internal/push`, `x-internal-key`), which looks up the
person's Expo push tokens and sends through **Expo Push → FCM HTTP v1** (Android) / APNs.
`type` must be on the realtime allow-list; each push collapses per entity
(`bookingId`/`appointmentId`/`orderId`), and time-bound ones expire (`booking_nearby`,
`identity_verified` 15 min; reminders 2 h).

| Module | Types |
|---|---|
| Home services | `booking_created`, `booking_update` (accepted / rejected / en route / arrived / **work started** / completed), `booking_cancelled` (customer / provider / **system release** / **expiry** / admin), `payment_requested`, `payment_received`, `payment_update` (cash selected), `booking_nearby`, `booking_reminder`, `review_received`, `identity_verified` |
| Healthcare | `appointment_update`, `appointment_reminder`, `prescription_ready`, `video_call_starting` |
| Shopping | `order_created`, `order_update`, `return_update`, `product_moderation` |

## Calling — signalling only (documented decision)

> Superseded: calls are now peer-to-peer WebRTC (`react-native-webrtc`) relayed
> through Cloudflare TURN when needed — see `CHAT_CALL_CHANGELOG.md` in the app
> repo. The section below describes the original FYP-I design.

**In-app voice is NOT implemented.** Given FYP-I scope, the call screens do
ring/accept/decline/end signalling over sockets and hand the actual audio to
the phone's native dialer (`tel:` intent with the counterparty's number). Both
the customer and provider call screens state this honestly.

| Event | Direction | Payload |
|---|---|---|
| `call_ring` / `call_accept` / `call_decline` / `call_end` | client → server → other room member | `{ bookingId }` → relayed as `{ bookingId, from: { id, role }, at }` |
