# Tech Nova — Setup Guide

This bundle fixes the four issues we talked through (exposed Gemini key,
base64 images in Firestore, no way to attribute earnings/tracking to a
collector, no real i18n) and adds multi-language support, chain-of-custody
tracking, collector earnings, and an area leaderboard.

## 1. Where each file goes

Replace the matching files in your existing project root with these:

| File in this bundle     | Goes to                          |
|--------------------------|-----------------------------------|
| `index.html`             | `index.html`                     |
| `style.css`               | `style.css`                       |
| `app.js`                  | `app.js`                          |
| `firebase-config.js`      | `firebase-config.js`              |
| `translations.js`         | `translations.js` (new)           |
| `functions-index.js`      | `functions/index.js` (new folder) |
| `functions-package.json`  | `functions/package.json`          |
| `firestore.rules`         | `firestore.rules`                 |
| `storage.rules`           | `storage.rules`                   |
| `firestore.indexes.json`  | `firestore.indexes.json`          |

If you don't already have a `functions/` folder, run `firebase init functions`
first (choose JavaScript, and when it asks to overwrite `index.html`/etc.
say no) — that gets you the rest of the CLI scaffolding, then drop these
two files in.

## 2. One-time Firebase console steps

1. **Enable Anonymous Authentication**: Console → Build → Authentication →
   Sign-in method → enable **Anonymous**. This is how collectors get a
   persistent identity (for "My Submitted Lots" and earnings tracking)
   without a login screen.
2. **Upgrade to the Blaze (pay-as-you-go) plan** if you're still on Spark.
   Cloud Functions that make outbound network calls (the Gemini proxy)
   require Blaze. It still has a generous free tier underneath.
3. **Seed the rate card**: Console → Firestore → create a document at
   `config/rateCard` with number fields matching your e-waste categories,
   e.g.:
   ```
   Printed Circuit Boards (PCBs): 250
   Copper Cables & Wires: 480
   Batteries (Li-ion/Lead Acid): 90
   Display Screens / CRTs: 60
   Mixed Electronic Scrap: 35
   ```
   These are ₹/kg placeholders — edit them any time without redeploying.
   The app falls back to the same defaults if this doc doesn't exist yet.

## 3. Deploy from the CLI

```bash
# Firestore rules + the composite index the collector query needs
firebase deploy --only firestore:rules,firestore:indexes

# Storage rules
firebase deploy --only storage

# Set the Gemini key as a Cloud Functions secret (never in source)
firebase functions:secrets:set GEMINI_API_KEY

# Install function dependencies, then deploy
cd functions && npm install && cd ..
firebase deploy --only functions

# Your existing hosting deploy, unchanged
firebase deploy --only hosting
```

If Firestore ever complains about a missing index at runtime (it happens
the first time a new query pattern runs), it prints a direct console link
that creates it in one click — that's a fine substitute for step above if
you'd rather not touch the CLI.

## 4. What changed, and why

- **Images** now upload to Cloud Storage (`pickups/{uid}/...`) instead of
  being base64-encoded into Firestore documents — smaller docs, cheaper
  reads, faster rendering.
- **The Gemini key** lives only in the `askAssistant` Cloud Function,
  set via `firebase functions:secrets:set`. `app.js` now calls it through
  `httpsCallable`, so nothing secret ships to the browser.
- **Collectors get an anonymous Firebase Auth identity** on first visit
  (no signup friction), which is what makes "My Submitted Lots" and the
  earnings/impact stats possible — every request is tagged with
  `collectorId`.
- **Chain-of-custody**: every request stores a `statusHistory` array
  (who changed what, and when), and the UI renders it as a three-step
  progress tracker on both the collector and recycler views.
- **Earnings**: computed client-side against a Firestore-editable
  `config/rateCard` doc for instant feedback, then optionally recomputed
  and overwritten server-side by `recomputeEarningsOnComplete` — deploy
  that function if you want the number to be tamper-resistant rather than
  just a convenience display.
- **Area leaderboard**: each request is tagged with an `areaLabel`
  (reverse-geocoded from the pin, or taken from the address search),
  and the recycler dashboard aggregates completed pickups by area,
  client-side, from data it already has loaded — no extra reads.
- **Translations**: `translations.js` holds hand-written EN/HI/TA/ES
  strings, applied via `data-i18n` attributes — no more DOM-scraping
  Google Translate widget, and it works on the dynamically rendered
  cards too.
- **Firestore/Storage rules** now enforce the trust boundaries described
  above: a collector can only create requests under their own uid and
  can't set `status` or `earnings` at creation; only a recognized
  recycler (has a `recyclers/{uid}` doc) can advance a request's status;
  weight/type/photo are immutable after creation.

## 5. Known trade-offs, so nothing surprises you later

- Reverse geocoding calls Nominatim directly from the browser. Fine for
  a pilot; for real traffic, proxy it through your own backend or a paid
  geocoding provider to respect Nominatim's usage policy.
- The area leaderboard is computed client-side from the recycler's full
  request feed. That's fine at hundreds–low thousands of requests; past
  that, switch to incremental rollup documents updated by a Cloud
  Function trigger, or export to BigQuery for heavier analytics.
- If a recycler account also submits a test pickup while logged in
  (switching to the Collector Portal tab without logging out), that
  pickup is attributed to the recycler's own uid rather than a fresh
  anonymous collector — a minor edge case, not a real-world flow.
