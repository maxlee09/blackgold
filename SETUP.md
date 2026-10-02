# Black & Gold: Supabase test ordering pilot

The site is hosted at https://maxlee09.github.io/blackgold/ and uses the Supabase project supplied by Max. Only the public publishable key is in the frontend. No database password or privileged key is required.

## 1. Create the tables and functions

Open the Supabase project -> SQL Editor -> New query. Copy the **entire** contents of [`supabase/setup.sql`](supabase/setup.sql) and click **Run**. The script runs as one transaction and can be rerun without overwriting changed menu prices or existing orders. It seeds a sample menu and enables test ordering.

## 2. Enable guest sessions

Open Authentication -> Sign In / Providers (or Providers) -> Anonymous Sign-ins and enable it. Guest checkout uses `signInAnonymously()` to give each browser a database identity; customers do not need to enter an email or create an account. If CAPTCHA is enabled for anonymous sign-ins, the current pilot needs a CAPTCHA integration before guest checkout can work; do not disable an existing CAPTCHA configuration on a production project.

This pilot has per-user, daily, queue and pickup-slot limits. Anonymous sessions can be recreated, so the per-user limit alone is not a production anti-abuse guarantee. Before a real launch, add verified CAPTCHA/edge rate limiting, confirm the real menu and hours, and implement operational/privacy and payment processes. Keep this pilot in test mode.

## 3. Create an approved staff account

In Authentication -> Users -> Add user, create an email/password user. Confirm the user's email (or select auto-confirm when creating them). Save the password privately.

Open [`supabase/add-staff.sql`](supabase/add-staff.sql), replace `YOUR_STAFF_EMAIL` with that user's email, then run it in SQL Editor. Staff permissions come from a private allowlist; simply registering or logging in does **not** grant staff access.

Use **Staff login** on the website and enter that email/password. No passwords belong in GitHub or this chat. To remove staff access later:

```sql
delete from private.staff_members
where user_id in (select id from auth.users where lower(email) = lower('STAFF_EMAIL'));
```

## 4. Test across two devices

1. On device A, choose a drink, a pickup slot and a fictional first name. Place a test order. A real `BG-...` confirmation means the order was saved.
2. On device B, log in as approved staff. The saved order appears in the queue. The dashboard polls every 10 seconds while visible.
3. Advance it through preparing and ready, then complete it. Completed/cancelled orders leave the active queue but remain in Supabase's `orders` table.
4. Manage prices and sold-out drinks through the staff dashboard. Existing orders retain their saved item names and prices.
5. Pause ordering and verify checkout is unavailable (the public menu refreshes every minute; the database blocks submissions immediately).

Until the SQL setup and anonymous sign-in configuration are complete, the page shows that ordering is unavailable. It does not silently create browser-only orders.

## Data and access

- Public: menu and non-sensitive store settings.
- Guests: read only their own orders and their items; cannot directly write order tables.
- Staff: approved staff can view the queue and manage products and order statuses using restricted functions.
- Database: calculates totals, snapshots prices, validates availability/options/quantities, applies queue/slot limits, and writes each order atomically.
- Retries: a request UUID makes repeated submissions with the same checkout details idempotent.
- This is a **test pilot**, not payment processing or a confirmed fulfillment service. No customer contact information is collected; use fictional names while testing. Anonymous sessions are persisted by Supabase Auth in the browser.

## Files

- `index.html`: polished frontend and embedded stock imagery.
- `app.js`: Supabase integration and protected staff UI.
- `supabase/setup.sql`: schema, access policies, sample menu and restricted functions.
- `supabase/add-staff.sql`: staff allowlist enrollment through the project owner's SQL Editor.
- `tests/`: database authorization/order tests and frontend smoke tests.

`store_settings.testing_mode = false` intentionally disables checkout in this pilot. Do not switch off test mode to try to launch real ordering; production behavior needs a separate implementation and owner-approved configuration.
