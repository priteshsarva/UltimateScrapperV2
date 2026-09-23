# Orders — how they arrive and what the owner does, click by click

## What the shopper does
1. On the store they tap **"Place order"** after filling name, phone, email, address, city, state, pincode.
2. Prices are recalculated by our server at that moment, so a stale page can never underpay.
3. Then they pay: a UPI QR page (**"Pay in your UPI app"**, or copy the UPI ID), or a payment-gateway
   page if the store has one. After paying they tap **"I've paid — send screenshot on WhatsApp"**,
   which marks the order as "payment claimed" and sends their screenshot to the store's WhatsApp.
4. If the store has no UPI or gateway set up, they simply get **"Complete on WhatsApp"** and send the
   order to the owner directly.

## Where the owner sees it
Portal → **"Orders"** in the left menu. Filter by **"Shop"** (or "All shops") and by status pills:
all / pending / processing / on-hold / completed / cancelled / refunded.
Each row shows the order number, buyer name, store, total and date. Click a row to open it.

Inside an order: **"Items"** (photo, size, quantity, price, margin), the money breakdown,
**"Fulfilment"**, and on the right **"Order {number}"** with the status dropdown, **"Payment"**,
and **"Customer"** with the full delivery address and phone.

## The statuses, in order
- **pending** — order placed, money not confirmed yet. Nothing ships at this stage.
- **processing** — payment verified. This happens **automatically** the moment the payment is verified.
- **on-hold / cancelled / refunded** — set by hand from the status dropdown, then **"Update"**.
- **completed** — the order is finished.
Payment has its own label: **Unpaid → Payment claimed → Paid**.

## Confirming the payment
- If the shopper pays into the **owner's own UPI**, the owner confirms it: open the order, check the
  money has actually arrived in the bank, then click **"Verify payment"** and type the UTR if they have it.
- If the **platform collects** the payment, our team verifies it and the owner's share is credited.
  The owner sees: "Payment is collected by the platform — the admin verifies it, then your share is credited."
- Gateway payments verify themselves, with nobody clicking anything.
- While waiting the owner sees: "Buyer says they've paid — check the statement, then verify."

**Never ship before the payment shows as verified.** Verification is also what reserves the stock.

## Shipping it
In the order, click **"📦 Mark shipped — upload proof"**. The form asks for:
- **"Courier"** (optional), **"Tracking number"** (optional)
- **"Parcel photos"** — **2 to 10 photos are required**; this is the proof that releases money.
Then **"Submit proof"**. The owner then sees "Proof submitted — awaiting admin approval",
our team checks it and releases the funds. If a proof is rejected the owner can upload again.

If the order is shipped directly to the customer by the supplier, the owner sees
"The wholesaler ships this order directly" and has nothing to upload.

## Money (only for stores where the platform collects payment)
Portal → **"Wallet"**: **"AVAILABLE"** (withdrawable), **"ON HOLD"** (releases when the shipment is
approved), **"IN PAYOUT"**, **"PAID OUT"**. To withdraw: save a **"Payout UPI ID"**, accept the payout
terms if shown, then **"Request payout"**. The minimum payout is shown on the screen, and the request
is always for the full available balance.
Where the shopper pays the owner's own UPI, the owner already has the cash and the wallet stays empty.

## What the system sends by itself
The shopper is emailed when the order is placed, when the payment is verified, and when the order is
completed, cancelled, on hold or refunded. Unpaid orders get a daily "Finish paying order" reminder
for up to 7 days. The owner is emailed on every new order.
WhatsApp messages to shoppers are **not** automatic — the owner sends those (see the copy-paste
messages in the shipping file).

## Common questions
**"Order aaya kaise pata chalega?"** — Email on every new order, and it appears in Orders in the portal.
**"Paisa aaya ki nahi kaise check karu?"** — Check the bank/UPI app, then click "Verify payment".
**"Ship kar diya, ab?"** — Upload 2-10 parcel photos as proof; the funds release after our check.
**"Customer ne paisa nahi diya"** — The order just stays pending. Nothing ships, nothing is owed.
**"Order cancel karna hai"** — Open the order, pick "cancelled" in the status dropdown, click "Update".
