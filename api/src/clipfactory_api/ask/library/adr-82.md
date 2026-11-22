## ADR-82 Your bank: Enable Banking restricted mode, read once a day, keep only matched app money

- **Context.** The owner asked (2026-11-21) for "a total of my exact number that I've gotten into my bank account or
  accounts, but in total for each of those platforms", Content Rewards, YouTube, TikTok, Instagram, Facebook and X
  included. ADR-64 showed what Google and Whop report as sent, but only his bank can say what arrived, and Meta,
  TikTok and X report nothing at all. He was offered four sources: A Enable Banking (restricted mode: free, BankID,
  his own accounts), B uploading his bank's CSV or xlsx file each month, C payout emails, D nothing new. He chose A on
  2026-11-22. He lives in Sweden. Research checked on 2026-11-22 (Enable Banking's docs, API spec, Control Panel text,
  Terms of Service of 2026-01-09 and end-user Privacy Notice of 2025-03-07) found:
  * restricted mode is free for production use on linked accounts "for the personal use of private individuals",
    with BankID and 180-day links at every major Swedish bank and PayPal;
  * the app signs with its own RSA key, and the Control Panel can take a public key made elsewhere, so the private
    key need never touch his browser;
  * the account answer carries his name, IBAN and address;
  * many banks allow 4 reads a day while he isn't there (PSD2 RTS Art. 36(5));
  * the Terms ban "any commercial purpose whatsoever", other people's accounts, business accounts, giving anyone else
    access, and abusive automated access; a breach "shall result in termination", with the user's liability uncapped;
  * no platform's payer name on a Swedish statement is documented, except Google's test deposits, Stripe's default
    "STRIPE" and Whop's "Whop";
  * Tink, Salt Edge, Plaid and Mastercard need a company contract, and GoCardless has closed sign-ups.
- **Options.** The source: A, B, C or D (his choice: A). The key: Enable Banking's default, a key made in his browser
  and saved as a .pem in Downloads, then uploaded; or a key made by Clip Factory's Lambda straight into Secrets
  Manager, with him pasting only the public part. What to keep: the transactions; every credit; or only the credits
  matched to an app. How to recognise a platform: store the payer's name and learn it; or keep only a keyed hash of
  it, plus Clip Factory's own platform word. Matching: let him type or pick amounts; or match by Google's and Whop's
  payment records, by payers he confirmed, and by asking him with one tap. Where reads run: a new Lambda; or
  `cf-prod-money`'s daily run, which already reads Google's and Whop's payouts. The terms risk: wait for Enable
  Banking's written answer before building; or build behind a switch that is off by default, offer him a ready email,
  read as little as possible, and make the switch the way back.
- **Decision.** (CONTRACTS §40.5)
  * **Enable Banking restricted mode, on his own Control Panel account and his own app, linking only his own personal
    accounts.** Every authorisation asks for `psu_type: "personal"`, business (`ORGA`) accounts are dropped before
    they are read, and a `BANKOWNER` claim keeps it to Clip Factory's one owner. The steps tell him never to press
    "Request activation" or "Share".
  * **The key is made by Clip Factory** (RSA-4096 and a 10-year self-signed certificate in `cf-prod-api`), and the
    private key goes straight into `cf-prod/platforms/bank/app`. He copies only the public part into "Generate outside
    the browser and import public certificate". If he already followed Enable Banking's default, an upload or paste
    box takes the .pem once, over HTTPS, straight into the same secret; it is never kept in the browser or logged.
  * **Each bank link's session** is its own runtime secret, `cf-prod/platforms/bank/token-{linkId}`. Both secret
    names fit today's IAM, so nothing in IAM changes.
  * **Least data.** Only booked credits are looked at, in memory, and only `CRDT` + `BOOK` rows with a platform word
    in the payer's text or a match to a payout record go on. Stored are only matched rows (day, amount in minor units,
    currency, place, how it was matched, a keyed-HMAC id) and the rows waiting for his answer, which expire after 180
    days. A "not app money" answer leaves only its id and day, for 400 days. Never stored: a name (not even the
    payer's: a keyed hash and Clip Factory's own word instead), an account number or its last 4, an IBAN, a balance, a
    debit, another transaction, the bank's text, his IP address or user agent (passed to Enable Banking for an
    attended read only). Logs carry counts.
  * **Matching** is one pure function: the exact amount and currency of a Google or Whop payout within 10 workdays;
    Whop's trace code; a payer he confirmed; otherwise a question card. Google's tiny test deposit is dropped by
    per-currency ceilings, which are Clip Factory's own numbers, never conversions. PayPal, Stripe and Payoneer carry
    money from several places, so they are asked about every time, and money moved from his own linked PayPal is asked
    about as a move so it isn't counted twice. Meta pays Instagram and Facebook in one payment, so it may be counted
    as "Instagram and Facebook together". He only ever taps; nothing is typed, converted or estimated.
  * **Reading** happens in `cf-prod-money`'s 06:00 UTC run after the payout reads, and on his Check now (an async
    invoke carrying his IP and user agent for that read only). The first read uses `strategy=longest` within the hour
    after BankID. At most 3 reads a day happen without him, and a bank's "too many" pauses reads for 6 hours.
  * **"Reached your bank"** is shown per place and per currency, plus a total per currency, tagged "Your bank says",
    on the Get paid Your bank card, the bank page, each place page and Money. It is never added to "Sent to your bank"
    or the 30-day total.
  * **The terms risk** is handled by building behind `bank_reading_enabled` (default `false`, switched on by one PR
    after the four builders merge), an optional first step with a ready email for him to send, and the switch as the
    way back. B's file upload stays possible later through the deposit's `source`.
- **Consequences.** Setup takes about 51 taps in one sitting (17 of them Clip Factory's), with BankID twice, because
  Enable Banking's Control Panel link doesn't authorise the app; after that, BankID every 180 days (a notice 7 days
  before) and one tap per new payer. A payout whose bank text names no platform is never seen, and the place says
  "Nothing … reached your bank yet" rather than a number; the first deposits teach the hint list, and a missing word
  is a one-line PR. Totals start at the oldest day his bank shows (often 90 days, more within the first hour). If
  Enable Banking says creator income isn't personal use, or deactivates the app, setting the switch to `false` takes
  every screen back to "Clip Factory can't see your bank", and his stored records stay until he taps Forget my bank.
  Additive only: new sort keys `BANKCONN`, `BANKLINK#`, `DEPOSIT#`, `BANKPAYERS`, the `BANKOWNER` registry item, two
  runtime secrets, two stream filters and one api env var changed in place; no new Lambda, table, index, role or IAM
  statement, and nothing that holds his data or connections is replaced.
