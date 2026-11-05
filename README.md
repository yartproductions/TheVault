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
3. **Activate Shopify listing:** switches the Shopify product from Draft to Active, publishes it to the Online Store and Shop channels, and once Shopify confirms, moves every unit in the listing to **Listed** in the Vault. The packet shows where it's visible, or why it isn't.

**Update Shopify draft / listing** re-syncs title, price, photos and quantity at any time.

### Listing descriptions (SYG rulebook)

The packet's **Lister notes** are plain English, not final copy: what the item is, what was tested, every defect and what's included, like you'd tell a coworker. **Generate listing** (also run automatically on Create Shopify draft) has Claude write the final listing from those notes plus the record's details, following the SYG "Thoky" listing rulebook in `functions/listing.js`:
- Title in the category format (phones: lock status → brand → model → model no. → MPN → storage → BH% → color → condition), max 80 characters, `-inch` screen sizes, no letter grades or banned words.
- Condition graded in words (New / Used – Good / Used – Fair / For Parts) from the notes; the Vault's "For Parts" always wins; For Parts ends with "Sold for parts or repair."; optional standard wear text for Used items (Settings).
- The eBay-safe HTML table is rendered by the Vault itself (navy Product Details / Shipping & Returns bars, alternating rows, "Shipping: Paid by buyer · calculated at checkout" and the chosen return policy (buyer pays return shipping)), so the template never drifts.
- `custom.*` metafields per type plus eBay readiness fields (category ID only from the confirmed list, condition code, returns).
- Missing details, values filled from research (it can do a few web lookups for model numbers and MPNs) and conflicts are shown in the preview.

**Provider switch** (Settings → Shopify → Listing generator): Claude (Anthropic) or OpenAI, or Auto (Claude when its key is set, otherwise OpenAI). Both get the same rulebook prompt and the same checks; OpenAI uses the Responses API with web search and automatic prompt caching, model set in Settings (default `gpt-5.4`). The preview shows which provider and model wrote it and the cost.

Both secrets must exist for the functions to deploy; set the one you don't use to `none`:
```
npx firebase-tools functions:secrets:set OPENAI_API_KEY      # paste the OpenAI key
npx firebase-tools functions:secrets:set ANTHROPIC_API_KEY   # paste the Anthropic key, or type: none
```
A listing costs a few cents and is regenerated only when the notes or details change.

### Product sync (Shopify → Vault)
Settings → Shopify → **Connect Shopify sync** subscribes paid orders plus product updates and deletions, all to the existing `shopifyOrderWebhook` endpoint (no new public function).
- **Deleted in Shopify:** the packet forgets the product (the steps go back to *Create Shopify draft*), Listed units return to Prepared, and the listing keeps its units so re-creating brings back the same quantity.
- **Status changed in Shopify:** Active moves Prepared units to Listed; Draft or Archived moves Listed units back to Prepared.
- **Safety net:** if a notice is missed, Update, Activate and the stock sync notice the product is gone and handle it the same way (Update creates a new product).

### Automatic item status
New → Processing as soon as someone edits the item, adds photos, sets the quantity or writes the listing; → Prepared when the Shopify draft is ready; → Listed on Activate. It only moves forward and never changes Listed, Sold or Archived items.

### Sales sync
- **Vault → Shopify:** recording a sale or a return in the Vault resets Shopify's quantity to the units still in stock. At zero the product goes back to Draft so it leaves the store.
- **Shopify → Vault:** press **Settings → Shopify → Connect Shopify orders** once. Every paid Shopify order then marks the sold units **Sold**, books each sale (price after discounts, Shopify fee 2.9% + $0.30, your flat shipping) with its bookkeeping entry, and logs it in Activity. Each order is recorded exactly once, even if Shopify sends it twice. Lines without a Vault SKU, or with more quantity than is in stock, show up in Settings → System log.
- The Shopify app needs these scopes: `write_products`, `write_inventory`, `read_orders` (order sync) and `read_publications` + `write_publications` (so **Activate** can put the product on the Online Store and Shop channels; API-created products otherwise stay invisible). After changing scopes, release a new app version and approve it in the store.
- The webhook function `shopifyOrderWebhook` must allow public access (Cloud Run → service → Security), like the other functions. It only accepts requests signed with the app's client secret. Configure the `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` Firebase secrets; never put them in `config.js` or Firestore. The Shopify app needs `write_products` and `write_inventory` access.

## eBay Market

The **Market** page shows, for every model in stock (plus any you add): how many are listed on eBay right now, the median price and its trend, an estimate of how many sell per week, your own past sales of that model, and a suggested price for a fast sale or for maximum profit. Each item page has a **Market check** box with one-click buttons to use those prices.

The top of the page shows the **total suggested value** of your stock in watched models (at fast and max prices, next to what you paid) and a **price confidence** score. Each model has its own confidence meter with a "Why this confidence?" breakdown. The score's rules and weights live in one place, `CONFIDENCE_RULES` in `index.html`, so they can be reworked without touching anything else.

**Matching to eBay.** Each model is matched to eBay's own item specifics (Brand, Model, Storage Capacity, Network) so the search only compares the same device, not cases, other storage sizes or carrier-locked phones. The match is found automatically, shown on each model ("✓ exact match" or "⚠ keyword search"), and can be fixed with **Fix match**, choosing from eBay's own values. Listings whose titles say they're accessories, iCloud-locked or for parts are filtered out, and each model shows a few of the listings it matched so you can check them. **Lots.** A record titled like `Lot of 4 | SK hynix 64GB` is priced as one unit (`SK hynix 64GB`) and multiplied by 4. eBay lot listings ("Lot of 5", "2x16GB") are divided into a per-unit price before comparing. Items the Vault has no fixed category for (RAM, SSDs, other parts) get their category from eBay. Records without a purchase cost show "Profit unknown" instead of a made-up profit.

**Precise details.** A brand and size alone ("SK hynix 64GB") matches many different products, so the Market reads identifying details from each record's title and specs: a **part number** (searched first, e.g. `HMA84GR7AFR4N-VK`), and eBay item specifics like type, speed, form factor and interface (`DDR4 2933MHz RDIMM`). Records without enough detail get a warning with links to fix them, and score lower in price confidence ("Item described precisely"). For phones, put storage and carrier in the specs (e.g. `128GB Unlocked Midnight`).

How it works: every 6 hours a Firebase function takes a snapshot of eBay's live fixed-price listings for each model through eBay's Browse API. eBay doesn't share sold prices, so "sold per week" counts listings that disappear between snapshots (most sold, some just ended). Only counts, prices and listing ids are kept.

Setup (once):
1. In the eBay developer portal, use your **Production** keyset (App ID = client ID, Cert ID = client secret).
2. eBay requires production apps to accept account-deletion notices. Under **Alerts and Notifications → Marketplace Account Deletion**, enter the endpoint `https://us-east1-obsidian-vault-38dfd.cloudfunctions.net/ebayAccountDeletion` and a verification token (32–80 letters, digits, `_` or `-`; for example from `openssl rand -hex 24`). Save, then **Send Test Notification**.
3. Deploy. The Firebase CLI asks for `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_VERIFICATION_TOKEN` (the same token as step 2) the first time.
4. Make `ebayaccountdeletion` publicly accessible in Cloud Run (Security tab), like the other functions.
5. Open **Market → Refresh now**.

## Photo cleanup

On the 1st and 15th of each month (America/New_York, early morning) a backend job keeps Firebase photo storage small without losing photos (rules in `functions/photos.js`):
- **On Shopify:** once Shopify reports its copies as READY, the item's photos switch to Shopify's copies and the Firebase files are deleted.
- **Sold or archived** for 14 / 30 (default) / 90 days with photos not on Shopify: the photos are deleted.
- **Unused uploads** no item refers to, after 14 days.
- **Never touched:** photos of in-stock items that aren't confirmed on Shopify.

**Settings → Photo cleanup** turns it on/off, sets the waiting period, shows the last run, and has **Preview cleanup** (nothing deleted) and **Run now** (owners only). Each run is logged in Activity; problems go to the System log.

## Database rules

`firestore.rules` gives every vault account two levels:
- **Members** read and add/edit records (intake, sales, packets, photos, bookkeeping entries) and can report errors to the system log.
- **Owners** (the two bootstrap emails, or accounts added with the Owner role) can also delete records, change settings and PINs, set counters from a backup, and read or clear the system log.
- Record codes can't be changed or skipped, the activity log can only grow, member accounts and Shopify order records are written only by the backend, and any collection not listed is closed.

`tests/rules.test.mjs` checks all of this in the Firestore emulator. The GitHub deploy workflow runs it first and stops if any check fails.

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
