# Obsidian Vault

The Obsidian Gadget internal app covers intake, the Inventory Vault, the Master Vault, Shopify listing packets with photos, sales, the Customer Vault, bookkeeping and an activity log of who did what. It is a static site: one `index.html` plus `config.js`, with no build step.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `config.js` | The only file you edit: Firebase keys and photo storage choice |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `storage.rules` | File storage rules, needed only if you set `photos: 'storage'` |
| `cors.json` | Needed only with `photos: 'storage'`, for the "Photos (.zip)" button |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

## 1. Put it on GitHub Pages (5 minutes)

1. Copy every file in this folder into the root of your repo (for example `ObsidianVault`). Overwrite the old `index.html` and delete the old `.js` and `.css` files, which this version no longer uses.
2. Commit and push.
3. In the repo, go to **Settings → Pages**. Under **Source**, pick **Deploy from a branch**, then `main` and `/ (root)`, and save.
4. Open `https://<your-user>.github.io/<repo>/`.

At this point the app runs in **local mode**. Everything saves in that browser only, the same way the old site did. It works, but other devices won't see the data. Step 2 turns on live sync.

## 2. Turn on live sync across devices (Firebase, free plan, about 15 minutes)

1. Go to <https://console.firebase.google.com>, click **Add project**, and name it (for example `obsidian-vault`). Google Analytics is optional; turn it off.
2. Create the database: **Build → Firestore Database → Create database**. Pick **Production mode** and a location close to you (for example `us-east1`).
3. Turn on email sign-in: **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
4. Create the two owner accounts in **Authentication → Users → Add user**: one email and password per owner. These are the logins each device uses once. The owner PINs inside the app still lock the workspace.
5. Lock down the data in **Firestore Database → Rules**. Paste in the contents of `firestore.rules`, replace `owner1@example.com` and `owner2@example.com` with the two emails from step 4, and click **Publish**. Without this step, anyone could sign up and read your data.
6. Allow your site in **Authentication → Settings → Authorized domains → Add domain**: add `<your-user>.github.io`.
7. Get the keys. Go to **Project settings** (gear icon) → **Your apps** and click the **`</>`** (Web) icon. Register the app (any nickname, no hosting) and copy the `firebaseConfig` object.
8. Open `config.js`, replace `firebase: null` with the object you copied, then commit and push.

Reload the site. It asks for the vault email and password once per device, then shows the PIN lock. The sidebar should read **"Synced · live on every device"**.

**The Firebase keys in `config.js` are not secrets.** They only identify the project. Protection comes from sign-in plus the rules from step 5.

### Photos

- **`photos: 'firestore'` (default):** works on the free Spark plan. Photos are compressed to about 1600 px (around 300–600 KB each) and stored in the database. That's plenty for listings, and the free plan holds 1 GB.
- **`photos: 'storage'`:** stores full-size originals in Cloud Storage. Cloud Storage now requires the pay-as-you-go **Blaze** plan; it stays free under the usage allowances, but a card must be on file. If you choose this:
  1. Go to **Build → Storage → Get started**.
  2. Paste `storage.rules`, using the same two emails as in step 5.
  3. So the "Photos (.zip)" button can download the photos, apply `cors.json` once with the Cloud Shell in Google Cloud: `gsutil cors set cors.json gs://<your-bucket>`.

## Shopify (not linked to any store)

Every listing packet has two buttons:
- **Shopify CSV:** in any store's admin, go to *Products → Import*.
- **Photos (.zip):** drag the photos onto the product.

To push drafts straight into a store later, open **Settings → Shopify integration → Direct API via relay** in the app. A browser can't hold a Shopify Admin token safely, so you need two things:

1. A custom app in the target store (*Settings → Apps → Develop apps*) with the `write_products` and `write_files` scopes.
2. A small relay (for example a Cloudflare Worker or Vercel function) that keeps that token.

The vault POSTs this to the relay:
```json
{ "title": "...", "descriptionHtml": "...", "price": "579.00", "sku": "VR-00012",
  "productType": "Laptop", "vendor": "Apple", "tags": ["obsidian-vault","VR-00012"],
  "photos": [{ "url": "...", "alt": "..." }], "productId": null }
```
and expects back `{ "id": "gid://shopify/Product/…", "adminUrl": "https://…" }`. The hand-off lives in `ShopifyAdapter` inside `index.html`.

Photo URLs are sent only when you use `photos: 'storage'`. With the default `'firestore'` photos, the relay gets an empty photo list, so upload those photos from the zip.

## Moving data in

In **Settings → Sync & data → Restore / import** you can load either kind of file:
- A vault backup, from **Download backup**.
- A backup from the old Obsidian Vault site (`gadget-flippers-backup-*.json`). Its items get fresh `VR-` codes and its customers are matched by phone number.

## Record codes

| Code | Record |
|---|---|
| `VR-` | Vault record (one physical item, permanent) |
| `PU-` | Purchase / intake |
| `LT-` | Listing |
| `SL-` | Sale |
| `RT-` | Return |
| `TX-` | Bookkeeping transaction |
| `AJ-` | Adjustment |
| `CU-` | Customer |

The numbers come from shared counters, so two devices never create the same code.

## Limits and good habits

- **Backups:** download one from Settings every week.
- **Free plan:** about 50,000 reads and 20,000 writes per day, which is far more than a two-person shop uses.
- **List size:** each list loads up to 1,000 records live. Past that, archive sold items by year and keep the backups.
