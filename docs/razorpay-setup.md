# Razorpay Integration — Setup & Workflow Reference

A from-scratch guide to how this project integrates Razorpay, written from the
actual code. Use it to re-create the setup, onboard a new environment, or debug
future payments.

---

## 1. Architecture Overview

Two apps in one repo:

| App | Stack | Responsibility |
| --- | --- | --- |
| `backend/` | Express 5 (ESM) + Mongoose + `razorpay` SDK | Create Razorpay orders, verify payment signatures, receive webhooks, persist to MongoDB |
| `frontend/` | React Router v7 + React 19 + Tailwind v4 + Vite | Collect amount, open Razorpay Checkout, call backend to verify |

```
 Browser                     Backend (Express :3000)              Razorpay
   │                                │                               │
   │  POST /api/payment/order ─────▶│                               │
   │                                │  orders.create() ────────────▶│
   │                                │◀── order_id ──────────────────│
   │                                │  Order.create() → MongoDB     │
   │◀── { success, id, amount } ────│                               │
   │                                                                │
   │  Razorpay Checkout (checkout.js) — user pays ─────────────────▶│
   │◀── { order_id, payment_id, signature } ───────────────────────│
   │                                                                │
   │  POST /api/payment/verify ────▶│  HMAC check (key_secret)      │
   │                                │  Order → paid                 │
   │                                │  Payment upsert → captured    │
   │◀── { success } ────────────────│                               │
   │                                                                │
   │                                │◀── webhook POST ──────────────│  (server-to-server)
   │                                │  HMAC check (webhook_secret)  │
   │                                │  Order/Payment updated        │
```

**Why two verification paths?** `/verify` is browser-triggered and gives the
customer instant feedback. The **webhook** is Razorpay → server and is the
authoritative source of truth (it still fires if the browser closes before
`/verify` runs). In production you trust the webhook; `/verify` is a UX nicety.

---

## 2. File Map

### Backend
| File | Purpose |
| --- | --- |
| `backend/index.js` | App wiring, all three controllers (`createOrderController`, `verifyPaymentController`, `capturePaymentController`) |
| `backend/razorpayConfig/razorpayCongfig.js` | Razorpay SDK instance (note: filename has a typo — "Congfig") |
| `backend/config/db.js` | `connectDB()` Mongoose connection helper |
| `backend/models/order.model.js` | `Order` schema |
| `backend/models/payment.model.js` | `Payment` schema |
| `backend/.env` | Secrets (gitignored) |

### Frontend
| File | Purpose |
| --- | --- |
| `frontend/app/routes/home.tsx` | The payment page — amount input, script loader, Checkout, verify call |
| `frontend/app/routes.ts` | Routes `index` → `routes/home.tsx` |
| `frontend/vite.config.ts` | Dev proxy `/api` → `http://localhost:3000` |
| `frontend/.env` | Public config — `VITE_RAZORPAY_KEY_ID` |

---

## 3. Prerequisites

- Node.js (project uses ESM; `backend/package.json` has `"type": "module"`)
- MongoDB running locally (or an Atlas URI)
- A Razorpay account with **Test Mode** keys
- (For webhooks) a public tunnel such as `ngrok`

---

## 4. Environment Variables

### `backend/.env`
```env
PORT=3000
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=replace_with_your_webhook_secret
CURRENCY=INR
RECEIPT_SECRET=some_receipt_id
MONGO_URI=mongodb://127.0.0.1:27017/razorpay_test
```

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from Razorpay Dashboard → Settings → API Keys. **Secret is server-only; never ship it to the browser.**
- `RAZORPAY_WEBHOOK_SECRET` — the signing secret you set when creating the webhook (see §7).
- `MONGO_URI` — defaults to `mongodb://127.0.0.1:27017/razorpay_test` if unset (`backend/config/db.js:4`).

### `frontend/.env`
```env
VITE_RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
```

Only the **key id** goes here. `VITE_`-prefixed vars are embedded in the client
bundle, so they must never contain secrets.

---

## 5. First-Time Setup

```bash
# 1. Backend deps
cd backend && npm install

# 2. Frontend deps
cd ../frontend && npm install

# 3. Start MongoDB (see §10 if the systemd service fails to start)
mongod --dbpath ~/mongo-data --port 27017 --bind_ip 127.0.0.1

# 4. Run backend (nodemon, port 3000)
cd ../backend && npm run dev

# 5. Run frontend (Vite, proxied /api → :3000)
cd ../frontend && npm run dev
```

Open the Vite URL, enter an amount in rupees, and pay with a Razorpay test card.

---

## 6. API Reference

Base path: `/api/payment`

### `POST /order` — create a Razorpay order
Request body:
```json
{ "amount": 100 }
```
`amount` is in **rupees**; the backend converts to paise (`Math.round(amount * 100)`, `index.js:56`).

Response `201`:
```json
{ "success": true, "message": "new order created successfully",
  "id": "order_XXXX", "currency": "INR", "amount": 10000 }
```

Also persists an `Order` doc with `status: "created"`.

### `POST /verify` — verify checkout signature (browser → server)
Request body (straight from Checkout's `handler`):
```json
{ "razorpay_order_id": "...", "razorpay_payment_id": "...", "razorpay_signature": "..." }
```
Server computes `HMAC-SHA256("<order_id>|<payment_id>", RAZORPAY_KEY_SECRET)` and compares (constant-time via `crypto.timingSafeEqual`). On match: sets `Order.status = "paid"` + `paymentId`, and upserts the `Payment` with `status: "captured"`, `event: "checkout.verify"`.

### `POST /webhook` — Razorpay server-to-server
- Uses the **raw** request body (registered with `express.raw(...)` *before* `express.json()`, `index.js:29-35`), because HMAC must run over the exact bytes.
- Verifies header `X-Razorpay-Signature` = `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)`.
- Handles events:
  | Event | Effect |
  | --- | --- |
  | `payment.captured` | Order → `paid`; Payment upsert `captured` (+ `method`, `email`, `contact`, `raw`) |
  | `payment.failed` | Order → `failed`; Payment upsert `failed` |
  | `order.paid` | Order → `paid` |
  | anything else | logged only |

---

## 7. Razorpay Dashboard Setup

1. **Test keys:** Dashboard → Settings → API Keys → generate Test Mode keys. Put them in `backend/.env`; put the **key id only** in `frontend/.env`.
2. **Webhook (optional but recommended):**
   - Expose the backend: `ngrok http 3000`
   - Dashboard → Settings → Webhooks → Add:
     - URL: `https://<ngrok-id>.ngrok-free.app/api/payment/webhook`
     - Events: `payment.captured`, `payment.failed`, `order.paid`
     - Set a signing secret → copy it into `RAZORPAY_WEBHOOK_SECRET`
   - Verify delivery under the webhook's logs tab.

---

## 8. Data Model

### `orders`
| Field | Type | Notes |
| --- | --- | --- |
| `razorpayOrderId` | String | unique, indexed |
| `amount` | Number | **paise** |
| `currency` | String | default `INR` |
| `receipt` | String | from `RECEIPT_SECRET` |
| `status` | Enum | `created` \| `paid` \| `failed` |
| `paymentId` | String | filled on success |
| `createdAt` / `updatedAt` | Date | timestamps |

### `payments`
| Field | Type | Notes |
| --- | --- | --- |
| `razorpayPaymentId` | String | unique, indexed |
| `razorpayOrderId` | String | indexed |
| `order` | ObjectId | ref → `Order` |
| `amount` / `currency` | Number / String | |
| `status` | Enum | `created` \| `captured` \| `failed` |
| `method` / `email` / `contact` | String | populated by webhook |
| `signature` | String | from `/verify` |
| `event` | String | e.g. `checkout.verify`, `payment.captured` |
| `raw` | Mixed | raw webhook entity |

---

## 9. End-to-End Flows

**Happy path**
1. User enters ₹ amount → `POST /api/payment/order`.
2. Backend creates Razorpay order + local `Order` (`created`) → returns `id`/`amount`.
3. Frontend loads `checkout.js`, opens Checkout with `key`, `order_id`, `amount`.
4. User pays → Checkout `handler` fires → `POST /api/payment/verify`.
5. Signature valid → `Order` becomes `paid`; `Payment` becomes `captured` (`checkout.verify`).
6. Razorpay also POSTs `payment.captured` to `/webhook` → same records enriched.

**Failure / cancellation**
- Checkout `payment.failed` → UI shows error.
- `modal.ondismiss` → UI shows "Payment cancelled".
- Razorpay `payment.failed` webhook → `Order.failed` + `Payment.failed`.

---

## 10. Troubleshooting

**`JSON.parse: unexpected end of data at line 1 column 1`**
The proxy returned an **empty body**. Almost always the backend never started —
because `connectDB()` rejected (MongoDB not running), so `app.listen` never ran.
Check: `curl -X POST http://localhost:3000/api/payment/order -H 'Content-Type: application/json' -d '{"amount":1}'`. Connection refused = backend down. `frontend/app/routes/home.tsx` now shows a clearer "backend and MongoDB running" message instead. Fix MongoDB first.

**MongoDB will not start (systemd) — kernel incompatibility**
MongoDB 8.0.21–8.0.29 deliberately refuses to start on Linux kernels 6.19–7.0.13
(`MongoDB cannot start: Linux kernel ... known incompatibility`, SERVER-121912).
Options: run `mongod` manually (see §5 / §11), upgrade to MongoDB **8.0.30+**,
downgrade to **8.0.4**, or use Docker `mongo:8.0.4` / MongoDB Atlas.

**`Payment verification failed`**
Signature mismatch — usually a wrong `RAZORPAY_KEY_SECRET`, or the verify body
isn't the raw Checkout payload. Ensure the secret is the **key** secret, not the webhook secret.

**`Invalid webhook signature`**
Wrong `RAZORPAY_WEBHOOK_SECRET`, or the route was mounted after `express.json()`
so the body was already parsed (it must stay before it, `index.js:29`).

**`Webhook secret not configured`**
`RAZORPAY_WEBHOOK_SECRET` is missing from `backend/.env`.

**Amount looks 100× off**
Razorpay uses **paise**. UI sends rupees; backend multiplies by 100. Store/display accordingly.

---

## 11. Verify It Works (DB inspection)

With `mongosh` installed:
```bash
mongosh "mongodb://127.0.0.1:27017/razorpay_test" --quiet --eval '
print("ORDERS:");   db.orders.find({},   {razorpayOrderId:1,status:1,paymentId:1,amount:1,_id:0}).forEach(printjson);
print("PAYMENTS:"); db.payments.find({}, {razorpayPaymentId:1,razorpayOrderId:1,status:1,event:1,amount:1,method:1,email:1,_id:0}).forEach(printjson);
'
```
A successful ₹1 payment should show an `order` with `status: "paid"` and a
`payment` with `status: "captured"` — `event: "checkout.verify"` if only the
browser path ran, or `payment.captured` (with `method`/`email`/`contact`) if the
webhook also fired.

---

## 12. Production Checklist

- [ ] Switch Test keys → Live keys; keep the secret server-side only.
- [ ] Serve over HTTPS; use a real, reachable webhook URL (not ngrok).
- [ ] Add webhook retry/idempotency handling (upserts already help).
- [ ] Never log secrets; keep `.env` gitignored (already configured).
- [ ] Trust the **webhook** as source of truth, not only `/verify`.
- [ ] Validate amount server-side (already done) and consider min/max limits.
- [ ] Restrict CORS to your frontend origin if the API becomes cross-domain.
- [ ] Add automated tests around signature verification (valid + invalid).

---

## 13. Naming Graveyard (known quirks)

- `backend/razorpayConfig/razorpayCongfig.js` — "Congfig" is a typo; keep the
  filename as-is or rename and update the import in `index.js:4`.
- `frontend/package.json` lists `razorpay` as a dependency, but it is **unused**
  in the frontend (Checkout is loaded via `checkout.js`). Safe to remove.
