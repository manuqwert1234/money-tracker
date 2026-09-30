# Money Tracker: setup (about 15 minutes, free)

## Part 1: Make the "server" (on your Mac)

1. Go to **sheets.new** → a blank Google Sheet opens. Name it `Money`.
2. Menu **Extensions → Apps Script**.
3. Delete everything in `Code.gs` and paste in the contents of **Code.gs** from this folder.
4. (Nothing to change here. You set your PIN and budget inside the app.)
5. Click **+** next to "Files" → **HTML** → name it `Index` (exactly). Paste in **Index.html**.
6. Click 💾 Save.
7. At the top, pick **setup** from the function dropdown → click **Run**.
   - Google asks for permission → **Review permissions** → choose your account.
   - You'll see "Google hasn't verified this app". That's normal, because it's your own script. Click **Advanced → Go to Money (unsafe) → Allow**.
8. Open **View → Logs** (or the Execution log at the bottom). Copy the **secret token** it prints. You'll need it for the iPhone.
9. Click **Deploy → New deployment** → ⚙️ → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (the Shortcut can't log in. Your PIN and token protect the data.)
   - **Deploy** → copy the **Web app URL** (ends in `/exec`).

Bank **emails** are now checked automatically every 10 minutes. ✅

## Part 2: Make bank SMS go in automatically (iPhone)

1. Open the **Shortcuts** app → **Automation** tab → **+** (or "New Automation").
2. Choose **Message**.
3. Set **Message Contains** → type `debited`.
   (Don't use "Sender". Bank senders like `VM-HDFCBK` can't be picked.)
4. Choose **Run Immediately** and turn **off** "Notify When Run" → **Next**.
5. **New Blank Automation** → add action **Get Contents of URL**:
   - URL: paste your **Web app URL**
   - Tap ▸ **Show More** → Method: **POST**
   - Request Body: **JSON**. Add 2 fields (type **Text**):
     - `token` → paste your **secret token**
     - `text` → tap the field, choose **Shortcut Input**, then tap it again and pick **Content**
6. **Done.**
7. Repeat steps 1–6 three more times with **Message Contains** set to `credited`, then `spent`, then `Sent Rs`.
   (These catch GPay/UPI payments, card spends, and HDFC/Kotak-style "Sent Rs." messages.
   If both a bank SMS and an email arrive for the same payment, it's only counted once.)

**Test it:** send yourself a text such as `Rs.10 debited from A/c XX1234 to VPA test@okaxis UPI Ref 123456789`.
It should appear in the Sheet within a few seconds.

## Part 3: Put the app on your iPhone Home Screen

The `docs/` folder is the phone app. It's hosted free on **GitHub Pages**, so it opens full-screen with its own icon.

**Your app is already live at: https://manuqwert1234.github.io/money-tracker/**

1. On your iPhone, open that link in **Safari**.
2. Tap **Share ⬆︎ → Add to Home Screen → Add**. The blue ₹ icon appears.
3. Open it. The first time only, paste your **Web app URL**. It then asks you to **create a PIN**.

From then on it syncs by itself: when you open it, when you come back to it, and every minute while it's open.
The pill at the top shows "Synced just now". If it's orange, the numbers are more than 15 minutes old.

*(Quick alternative without GitHub: open the Web app URL in Safari and Add to Home Screen.
It works the same but shows Google's grey banner at the top.)*

If you change `Index.html`, copy it to `docs/index.html` too.

## Part 4: Budgets and overspending alerts

Tap **⚙️ Settings** in the app to change, at any time:
- your monthly budget
- limits per category (Food, Shopping, …)
- the size of payment that counts as a "big payment" warning
- the 9pm overspending email, on or off
- your PIN

Payments in the wrong category? In the Sheet's **Categories** tab, add a row, e.g. `ramesh` → `Rent`.

## Tips

- **"Money in bank"** adds up the latest *Avl Bal* from each account's SMS. If your bank never sends a balance,
  that account shows the net in/out instead. Once any message with a balance arrives, the total is exact.
- Messages it couldn't read go to the **Unparsed** tab. Send me a few (hide your account number) and I'll teach it that format.
- OTPs, "will be debited" autopay reminders, card bill "amount due" messages and loan offers are ignored on purpose.
- If you ever change `Code.gs`: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
