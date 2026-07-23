# Dispatch portal

Receives contacts from n8n, routes each one to a sub-account based on its tag,
and forwards it to that sub-account's workflow webhook.

```
n8n  ──POST──▶  /api/dispatch  ──▶ matches tag to a saved sub-account
                                └─▶ POSTs to that sub-account's webhook
                                    └─▶ GHL workflow creates the contact
```

Anything whose tag matches no sub-account is **returned in the response**, never
dropped silently.

---

## 1. Create the tables

Supabase → SQL Editor → run `schema.sql`. Creates:

- `dispatch_destinations` — the saved settings (name + webhook + active)
- `dispatch_log` — every dispatch, for auditing where a contact went

## 2. Deploy

Push this folder to Vercel (`vercel deploy`, or drag it into the dashboard).
No build step and no npm packages — the API talks to Supabase over REST.

## 3. Set environment variables

Vercel → Project → Settings → Environment Variables:

| Name | Value | Required |
|---|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | yes |
| `SUPABASE_SERVICE_KEY` | the **service_role** key (Supabase → Project Settings → API) | yes |
| `DISPATCH_TOKEN` | any long random string | recommended |

The service_role key bypasses row-level security, so it must only ever live in
Vercel's environment — never in the page.

Without `DISPATCH_TOKEN` the endpoint is open to anyone who finds the URL. Set it
before going live, then send it from n8n as the `X-Dispatch-Token` header and
paste it once into the portal under "Access token".

Redeploy after adding variables.

## 4. Add sub-accounts

Open the deployed site. For each sub-account, enter its **name** (exactly the tag
your contacts carry) and the **webhook URL** of the workflow that creates contacts
in it. Matching ignores case, spaces and punctuation, so `Agency Ark` catches
`agency-ark` and `AGENCY ARK`.

Use **Send test contacts** to confirm the wiring before pointing n8n at it.

## 5. Point n8n at it

An HTTP Request node:

- **Method** POST
- **URL** `https://your-app.vercel.app/api/dispatch`
- **Headers** `Content-Type: application/json`, `X-Dispatch-Token: <token>`
- **Body**

```json
{
  "contacts": [
    { "lead_id": "B0001-V-20260722-L0001",
      "firstName": "John", "lastName": "Smith",
      "phone": "+14155550134", "email": "john@example.com",
      "tags": ["Agency Ark"] }
  ]
}
```

Send the whole batch in one call. A bare JSON array works too, and the tag can be
`tags`, `tag`, `subaccount`, `destination`, or `destination_name`.

### Response

```json
{
  "run_id": "…",
  "received": 120,
  "sent": 118,
  "unrouted": 2,
  "results": [ { "destination": "Agency Ark", "count": 118, "status": "sent" } ],
  "unrouted_contacts": [ … ],
  "unmatched_tags": ["Not A Real Sub-account"]
}
```

Check `unrouted` in n8n. If it's above zero, either a sub-account is missing from
the portal or a tag is spelled differently — the contacts come back so you can
retry them once it's fixed.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/dispatch` | receive contacts and route them |
| GET | `/api/destinations` | list saved sub-accounts |
| POST | `/api/destinations` | add one — `{ name, webhook_url }` |
| PATCH | `/api/destinations?id=…` | rename, change webhook, pause/resume |
| DELETE | `/api/destinations?id=…` | remove one |
| GET | `/api/history?limit=40` | recent dispatch receipts |

## Notes

Each destination gets **one** POST containing all its contacts, not one per
contact — keeps you well inside rate limits on large batches.

A forward that doesn't answer within 20 seconds is marked failed and logged;
the other destinations still go through.

A paused sub-account receives nothing, and its contacts come back as unrouted
rather than being sent elsewhere.
