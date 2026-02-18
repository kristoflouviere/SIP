# Google Contacts Import Troubleshooting

Use this checklist when Gmail import returns ~500 contacts but your account has more.

## 1) Confirm required OAuth scopes are granted

The app now needs both:
- `https://www.googleapis.com/auth/contacts.readonly`
- `https://www.googleapis.com/auth/contacts.other.readonly`

Steps:
1. Open `https://myaccount.google.com/permissions`
2. Remove access for your app (SIP-IO).
3. Re-run import and approve consent again.

Why: previously granted tokens may not include the newer `contacts.other.readonly` scope.

## 2) Verify app OAuth and API config

In Google Cloud Console (same project as your `GOOGLE_CLIENT_ID`):
1. Ensure **People API** is enabled.
2. OAuth consent screen is in Testing (or Production) and your account is an approved test user (if Testing).
3. OAuth client has redirect URI exactly:
   - `http://localhost:5173/contacts` (dev)

## 3) Use diagnostics from import response

After import, inspect the `POST /contacts/import/google` response in browser DevTools > Network.

The response includes:
- `diagnostics.connections.pages`
- `diagnostics.connections.received`
- `diagnostics.connections.accepted`
- `diagnostics.otherContacts.pages`
- `diagnostics.otherContacts.received`
- `diagnostics.otherContacts.accepted`
- `diagnostics.totalAccepted`

Interpretation:
- `connections.pages = 1` and no additional pages: Google only returned one page for `me/connections`.
- `otherContacts.received = 0`: your account has no `Other contacts` visible to this API scope/account.
- High `skippedEmpty`: many entries lacked usable fields for your contact model.
- High `skippedDuplicate`: duplicate `resourceName` records were deduped.

## 4) Determine whether missing contacts are in labels/groups

The import currently reads:
- `people/me/connections`
- `people/otherContacts`

If your missing contacts are mostly in special contact groups/labels not surfaced as connections, compare counts in Google Contacts UI:
1. `Contacts` (My Contacts)
2. `Other contacts`

If totals are still mismatched, capture one import response JSON with `diagnostics` and use it to pinpoint which source is short.

## 5) Quick sanity checks

- Re-run import in an incognito browser session.
- Confirm server env values are correct:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`
- Verify backend is running the latest code.

## 6) If still limited near 500

Likely root causes:
- Scope not fully re-granted after scope change.
- Contacts not in `connections` or `otherContacts` for the authenticated account.
- Data is present but filtered out due to empty key fields.

Next action: send the `diagnostics` payload from one failed import run and compare against expected Google Contacts category counts.
