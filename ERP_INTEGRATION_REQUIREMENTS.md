# CEO Agent ↔ ERP Integration — What the ERP Project Needs to Build

This is the spec for the **other project's** team (the ERP). CEO Agent's side
(SSO verification, org auto-provisioning, consent screen) is already built.
This document lists exactly what needs to exist on the ERP side for the
integration to work: one login button and a handful of data endpoints.

Two independent pieces — build them separately, in this order:

1. **Single sign-on button** — lets an ERP user open CEO Agent already
   logged in, auto-creating the CEO Agent org on first use.
2. **Data sync API** — lets CEO Agent read customers/orders/inventory from
   the ERP, and lets the ERP receive marketing results back.

---

## 1. Single sign-on button

### What happens end to end
1. User clicks "Open in CEO Agent" inside the ERP.
2. **ERP backend** (never the browser/frontend) mints a signed token and
   redirects the browser to:
   `https://<ceo-agent-host>/sso/erp?token=<token>`
3. CEO Agent verifies the token and shows a one-time consent screen
   ("Create a CEO Agent org for `<company>`?" / "Sign in as `<user>`?").
4. User clicks **Allow** → CEO Agent creates (first time) or reuses the org
   linked to this ERP company, and signs the browser in.

### What the ERP needs to build
A server-side route behind the button (e.g. `GET /ceo-agent/launch`) that:

1. Reads the **currently logged-in ERP user and their company**.
2. Builds this JSON payload:
   ```json
   {
     "erpOrgId": "<stable, permanent id of the company/tenant in the ERP — never the user id>",
     "erpUserId": "<id of the logged-in user>",
     "email": "<user's email>",
     "name": "<user's display name>",
     "orgName": "<company display name — used only the first time this erpOrgId is seen>",
     "exp": 1735900000000
   }
   ```
   - `exp` = current time in epoch **milliseconds** + 5 minutes (`Date.now() + 5*60*1000`). The token is single-use/short-lived — mint it right before redirecting, don't cache or reuse it.
   - `erpOrgId` **must be stable** across logins — it's the permanent key CEO Agent uses to recognize "this is the same company" on every future click. Never derive it from something that can change (email, display name).
3. Encodes it: `payload = base64url(JSON.stringify(thatObject))`
4. Signs it: `signature = base64url(HMAC_SHA256(key = ERP_SSO_SECRET, message = payload))`
5. Concatenates: `token = payload + "." + signature`
6. Redirects the browser (HTTP 302) to:
   `https://<ceo-agent-host>/sso/erp?token=<url-encoded token>`

### `ERP_SSO_SECRET`
- A long random string (e.g. `openssl rand -hex 32`), generated once by whoever operates both systems.
- Set as an env var on **both** servers: `ERP_SSO_SECRET` on CEO Agent, and the same value on the ERP's backend.
- **Must never appear in frontend/browser code** — only the ERP's backend signs tokens.

### Reference implementation (Node.js — adapt to the ERP's actual stack)
```js
import { createHmac } from "node:crypto";

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function mintCeoAgentSsoToken({ erpOrgId, erpUserId, email, name, orgName }) {
  const payload = base64url(JSON.stringify({
    erpOrgId, erpUserId, email, name, orgName,
    exp: Date.now() + 5 * 60 * 1000,
  }));
  const signature = base64url(
    createHmac("sha256", process.env.ERP_SSO_SECRET).update(payload).digest()
  );
  return `${payload}.${signature}`;
}

// In the button's route handler:
app.get("/ceo-agent/launch", requireLogin, (req, res) => {
  const token = mintCeoAgentSsoToken({
    erpOrgId: req.company.id,
    erpUserId: req.user.id,
    email: req.user.email,
    name: req.user.name,
    orgName: req.company.name,
  });
  res.redirect(`https://<ceo-agent-host>/sso/erp?token=${encodeURIComponent(token)}`);
});
```

### Checklist
- [ ] `ERP_SSO_SECRET` generated and set as an env var on the ERP backend (same value given to CEO Agent's operator).
- [ ] Button's backend route mints the token server-side and does an HTTP redirect — no token logic in frontend JS.
- [ ] `erpOrgId` confirmed stable/permanent (use the company's internal DB id, not email/slug/name).
- [ ] Manual test: click the button while logged into the ERP, confirm the CEO Agent consent screen shows the right company/user name, click Allow, land on CEO Agent dashboard signed in.

---

## 2. Data sync API

CEO Agent needs to **read** customers, orders, and inventory from the ERP,
and needs the ERP to **receive** marketing/campaign results back. This part
still needs the ERP's actual endpoint paths and field names filled in below
— send those over and the CEO Agent side gets built against them.

### Auth
Recommend a simple API key, separate from `ERP_SSO_SECRET` (that one's only
for login handoffs, not data access):
- Header: `Authorization: Bearer <ERP_DATA_API_KEY>` (or whatever scheme the ERP already uses for its other integrations — reuse it if one exists).
- One key per ERP company (`erpOrgId`), so CEO Agent only ever reads that company's own data.

### 2a. Customers/contacts → CRM leads
**Needed from the ERP:** an endpoint to list customers, paginated, ideally filterable by "updated since" for incremental sync.

```
GET /api/customers?updated_since=<ISO8601>&page=<n>
```
Suggested fields per customer (map to whatever the ERP actually calls them):
| Field | Notes |
|---|---|
| `id` | stable customer id |
| `name` | |
| `company` | optional |
| `email` | |
| `phone` | optional |
| `createdAt` / `updatedAt` | ISO8601 |
| `tags` / `segment` | optional, helps targeting |

### 2b. Orders/sales → analytics
```
GET /api/orders?since=<ISO8601>&page=<n>
```
| Field | Notes |
|---|---|
| `id` | |
| `customerId` | links back to 2a |
| `amount` | numeric |
| `currency` | e.g. "USD" |
| `status` | e.g. placed/paid/cancelled/refunded |
| `createdAt` | ISO8601 |
| `items` | optional array of `{ productId, qty, price }` |

### 2c. Inventory/products
```
GET /api/products?page=<n>
```
| Field | Notes |
|---|---|
| `id` / `sku` | |
| `name` | |
| `stockLevel` | numeric |
| `price` | numeric |
| `category` | optional, helps promo targeting |

### 2d. Marketing results → written back to the ERP
**Needed from the ERP:** one endpoint CEO Agent can POST to after a campaign/send, so results show up inside the ERP too.
```
POST /api/marketing-results
Content-Type: application/json

{
  "campaignId": "...",
  "channel": "email" | "linkedin" | "instagram" | "whatsapp" | "...",
  "sentAt": "<ISO8601>",
  "targetCustomerIds": ["..."],
  "metrics": { "sent": 120, "opened": 54, "clicked": 12, "replied": 3 }
}
```
Exact shape is flexible — whatever the ERP's reporting/CRM screens can actually display. Returning `erpOrgId`-scoped auth (same API key as above) is enough; no need for a separate secret.

### What we need from the ERP team before this half can be built
- [ ] Does an API like this already exist for other integrations? If so, send its docs — easier to conform to it than invent a new one.
- [ ] Confirm real field names/types for customers, orders, products.
- [ ] Confirm whether results write-back is wanted now or can wait — it's the one new concept the ERP doesn't have yet, so it's the most work on their side.
- [ ] Confirm pagination style (page number vs. cursor) and rate limits, if any.

---

## Summary — who does what

| Piece | Owner | Status |
|---|---|---|
| `/sso/erp` verify + consent + auto-create org | CEO Agent | ✅ Done |
| Login button backend route (mint token, redirect) | **ERP** | To build |
| `ERP_SSO_SECRET` provisioned on both sides | **Both** (shared secret) | To do |
| `GET /api/customers`, `/api/orders`, `/api/products` | **ERP** | To build |
| `POST /api/marketing-results` | **ERP** | To build |
| ERP data API key issuance | **ERP** | To build |
| CEO Agent connector that calls the above | CEO Agent | Pending ERP endpoint details |
