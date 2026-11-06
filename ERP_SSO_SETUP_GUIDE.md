# CEO Agent SSO — Step-by-Step Setup Guide for the ERP Team

Status: **CEO Agent's side is live and confirmed working** at
`https://srv1864510.hstgr.cloud/sso/erp`. This guide is everything the ERP
project needs to do on its own system to finish the connection.

---

## Step 1 — Get the shared secret

CEO Agent's operator has already generated a secret and set it as
`ERP_SSO_SECRET` on the CEO Agent server. Get that **exact same value** from
them (it was shared with you separately/securely — don't paste it into this
file or commit it to git).

⚠️ Known gotcha we hit during setup: when pasting the secret into an env
file, make sure **no extra text or spaces** get included. A bad paste earlier
turned `ERP_SSO_SECRET=b45ca826...` into `ERP_SSO_SECRET=ssh= b45ca826...`
(stray `ssh=` prefix + a space), which silently broke verification. Copy
only the raw hex string, nothing else, no trailing space.

## Step 2 — Set the secret in your backend's env

Add to your backend's env file (e.g. `Backend/.env`):

```ini
ERP_SSO_SECRET=<the exact value from Step 1>
CEO_AGENT_URL=https://srv1864510.hstgr.cloud
```

## Step 3 — Build the "Open in CEO Agent" button's backend route

This must run **server-side only** — the secret must never reach frontend/
browser JavaScript. The route behind your button (you already have one at
`/api/crm/ceo-agent/sso`) should, for the **currently logged-in ERP user**:

```js
import { createHmac } from "node:crypto";

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function mintCeoAgentSsoToken({ erpOrgId, erpUserId, email, name, orgName }) {
  const payload = base64url(JSON.stringify({
    erpOrgId,   // stable, permanent id of the company/tenant — see Step 4
    erpUserId,  // id of the logged-in user
    email,
    name,
    orgName,    // display name, only used the very first time this erpOrgId is seen
    exp: Date.now() + 5 * 60 * 1000, // 5-minute expiry — token is single-use
  }));
  const signature = base64url(
    createHmac("sha256", process.env.ERP_SSO_SECRET).update(payload).digest()
  );
  return `${payload}.${signature}`;
}

// Route behind the button:
app.get("/api/crm/ceo-agent/sso", requireLogin, (req, res) => {
  if (!process.env.ERP_SSO_SECRET || !process.env.CEO_AGENT_URL) {
    return res.status(503).json({ success: false, message: "CEO Agent is not configured yet. Please contact support." });
  }
  const token = mintCeoAgentSsoToken({
    erpOrgId: req.company.id,
    erpUserId: req.user.id,
    email: req.user.email,
    name: req.user.name,
    orgName: req.company.name,
  });
  res.redirect(`${process.env.CEO_AGENT_URL}/sso/erp?token=${encodeURIComponent(token)}`);
});
```

(If your existing route already does something like this, just confirm it
matches this payload shape and signing method exactly — a mismatch anywhere
produces "Invalid SSO signature" on the CEO Agent side.)

## Step 4 — Confirm `erpOrgId` is stable

`erpOrgId` is the permanent key CEO Agent uses to recognize "this is the
same company" on every future login — it decides whether a new CEO Agent
org gets created or an existing one gets reused. Use your internal company/
tenant **database id**. Never derive it from something that can change,
like an email domain or a display name.

## Step 5 — Restart your backend

Env file changes only take effect after a restart — however your backend is
run (systemd/PM2/Docker/etc.), restart it now so `ERP_SSO_SECRET` and
`CEO_AGENT_URL` are actually loaded into the running process.

## Step 6 — Test end to end

1. Log into the ERP as a real user.
2. Click the "Open in CEO Agent" button.
3. You should land on a CEO Agent consent page:
   - First time for this company: *"Create a CEO Agent organization for
     \<your company name>?"*
   - Returning: *"Sign in to CEO Agent as \<your email>?"*
4. Click **Allow**.
5. You should land on the CEO Agent dashboard, signed in.

## Troubleshooting

| What you see | What it means |
|---|---|
| `503` + `"CEO Agent is not configured yet"` | **Your own backend's** message — `ERP_SSO_SECRET` or `CEO_AGENT_URL` missing in your env, or backend wasn't restarted after setting them. |
| CEO Agent page: `"Cannot GET /sso/erp"` | CEO Agent's server is unreachable or out of date at that URL — contact the CEO Agent team, nothing to fix on your side. |
| CEO Agent page: `"ERP SSO is not configured on this server — set ERP_SSO_SECRET"` | CEO Agent's **own** server is missing the secret — contact the CEO Agent team. |
| CEO Agent page: `"Invalid SSO signature"` | The two sides' `ERP_SSO_SECRET` values don't match exactly (check for the stray-text/whitespace issue from Step 1), or the payload isn't being signed the way Step 3 shows. |
| CEO Agent page: `"SSO token expired — click the button again"` | More than 5 minutes passed between minting the token and the browser hitting `/sso/erp` (e.g. page was cached/reopened later) — mint it fresh on each click, don't reuse an old link. |
| CEO Agent page: `"SSO token missing erpOrgId/erpUserId"` | Payload is missing a required field — check Step 3's payload shape. |

---

## What's next (separate, not yet started)

Once SSO is confirmed working end to end, the next piece is data sync:
CEO Agent reading customers/orders/inventory from the ERP, and the ERP
receiving marketing results back. That spec and its open questions are in
`ERP_INTEGRATION_REQUIREMENTS.md` (section 2) — it's waiting on your team to
send over real endpoint paths and field names before that gets built.
