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

### Add vault accounts

After deploying the included Firebase Functions and updated rules, an owner can open **Settings → Vault access accounts**, add any number of email accounts, and copy each person's one-time password setup link. Members can use the vault; owners can also add or disable accounts. The two bootstrap owner emails in `firestore.rules` and `functions/index.js` keep the original owners from being locked out while membership records are created.

Deploy the backend with:

```sh
firebase deploy --only functions,firestore:rules,storage
```

**The Firebase keys in `config.js` are not secrets.** They only identify the project. Protection comes from sign-in plus the rules from step 5.

### Photos

- **`photos: 'firestore'`:** works on the free Spark plan. Photos are compressed to about 1600 px (around 300–600 KB each) and stored in the database.
- **`photos: 'storage'` (current configuration):** stores full-size originals in Cloud Storage and gives Shopify usable image URLs. Cloud Storage requires the pay-as-you-go **Blaze** plan. To finish setup:
  1. Go to **Build → Storage → Get started**.
  2. Paste `storage.rules`, using the same two emails as in step 5.
  3. So the "Photos (.zip)" button can download the photos, apply `cors.json` once with the Cloud Shell in Google Cloud: `gsutil cors set cors.json gs://<your-bucket>`.

## Shopify (not linked to any store)

Every listing packet has two buttons:
- **Shopify CSV:** in any store's admin, go to *Products → Import*.
- **Photos (.zip):** drag the photos onto the product.

With Firebase Functions deployed, Settings can switch Shopify to **Create Shopify drafts**. The listing flow is:

1. **Quantity in this listing:** use − / ＋ in the packet to pull in other in-stock units from the same purchase with the same title. Those units link to this listing and can't be listed separately.
2. **Create Shopify draft:** creates an unpublished product (SKU = the Vault code, e.g. `VR-00001`), sets Shopify's quantity to the number of units, and opens the product in a new tab.
3. **Activate Shopify listing:** switches the Shopify product from Draft to Active and, once Shopify confirms, moves every unit in the listing to **Listed** in the Vault.

**Update Shopify draft / listing** re-syncs title, price, photos and quantity at any time. Configure the `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` Firebase secrets; never put them in `config.js` or Firestore. The Shopify app needs `write_products` and `write_inventory` access.

## System log (developer maintenance)

**Settings → System log** is a terminal-style view of every error the system hits, from every device:
- **App:** crashes and unhandled errors in the page.
- **Sync:** saves or live updates that failed.
- **Backend:** failed Firebase Function calls, recorded by both the page and the function itself (with the raw Firebase/Shopify error).
- **Shown to user:** every red error message someone saw.

Click a line for details (user, page, device, error code, stack trace). **Copy** or **Download** the log to share it, **Test entry** checks logging works, and **Clear log** deletes the entries. Entries live in the `syslog` collection; the view shows the latest 300.

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
