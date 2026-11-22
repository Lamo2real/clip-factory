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
    "Request activation", "Request unrestriction" or "Share".
  * **The key is made by Clip Factory** (RSA-4096 and a 10-year self-signed certificate in `cf-prod-api`), and the
    private key goes straight into `cf-prod/platforms/bank/app`. He copies only the public part into "Generate outside
    the browser and import public certificate". **One exception, kept for his OK:** the task asked for an upload or
    paste box like the TikTok file box, so if he already followed Enable Banking's default, that box takes the .pem
    once, over HTTPS, straight into the same secret. It is the one place the private key passes through his browser
    (and his Downloads folder), against the rule that it never does. So the screen first says "Better: make a new app
    with Generate outside the browser…", the paste box has no autocomplete or spellcheck and is emptied after the
    send, nothing is logged, and a line stays until he taps "I deleted it" to remove the file from Downloads. Removing
    the box is a one-file change in BW if he says no.
  * **Each bank link's session** is its own runtime secret, `cf-prod/platforms/bank/token_{linkId}` (an underscore,
    so the `*/token-*` write grant that money, clip-flow and stats hold for rotated platform tokens never matches it).
    Both names fit today's Allow statements. Two in-place Deny statements keep `cf-prod-clip-flow` and `cf-prod-stats`,
    which can read `cf-prod/platforms/*`, from reading `…/bank/*`. Every bank secret is read with the cache off, so a
    reconnect or a new key is seen at once, and a read acts only on the session whose `connectedAt` matches its link.
  * **Least data.** Only booked credits are looked at, in memory, and only `CRDT` + `BOOK` rows with a platform word
    in the payer's text or a match to a payout record go on. Stored are only matched rows (day, amount in minor units,
    currency, place, how it was matched, a keyed-HMAC id built from the bank's entry reference, day, amount and
    currency, never from the account) and the rows waiting for his answer, which expire 180 days after the later of
    their booking and the read. A "not app money" answer leaves only its id and day, for 400 days. Never stored: a
    name (not even the payer's: a keyed hash of the payer's name and Clip Factory's own word instead), an account
    number or its last 4, an IBAN, a balance, a debit, another transaction, the bank's text, his IP address or user
    agent (passed to Enable Banking for an attended read only). Logs carry counts, and bank errors are typed so no
    answer body reaches a log.
  * **Matching** is one pure function, in this order: the exact amount and currency of a Google or Whop payout within
    10 workdays (a candidate whose platform word fits wins a tie); Whop's trace code (10 or more characters, as whole
    words); Google's tiny test deposit, dropped by per-currency ceilings that are Clip Factory's own numbers, never
    conversions; his "not app money" payers; a payer he confirmed; otherwise a question card. The payout records come
    first, so a "not app money" answer can never hide a real payout. Only a platform word in the bank's payer name is
    ever learned: anyone can write "YOUTUBE" in a transfer's message, so a word found only there is asked about every
    time. PayPal, Stripe and Payoneer carry money from several places, so they are asked about every time, and money
    moved from his own linked PayPal is asked about as a move so it isn't counted twice. Meta pays Instagram and
    Facebook in one payment, so it may be counted as "Instagram and Facebook together". He only ever taps; nothing is
    typed, converted or estimated.
  * **Reading** happens in `cf-prod-money`'s 06:00 UTC run after the payout reads, and on his own bank Check now (an
    async invoke carrying his IP and user agent for that read only, dropped if the event waited more than 120 s);
    Money's own Check now never reads the bank. His first read uses `strategy=longest` within the hour after BankID;
    a first read without him uses 89 days. At most 3 reads in any rolling 24 hours happen without him, a bank's "too
    many" pauses reads for 6 hours, and a lease keeps two reads (or a read and Forget) from meeting.
  * **The way back from BankID** is a public page, `/bank-done`, that needs no sign-in and holds no data, so the Mac
    app's system browser or another browser never lands on a sign-in page; the callback also writes the result on
    `BANKCONN`, so the waiting bank page always learns it.
  * **"Reached your bank"** is shown per place and per currency, plus a total per currency, tagged "Your bank says",
    on the Get paid Your bank card, the bank page, each place page and Money. It is never added to "Sent to your bank"
    or the 30-day total.
  * **The terms risk** is handled by building behind `bank_reading_enabled` (default `false`, switched on by one PR
    after the four builders merge), an optional first step with a ready email for him to send, and the switch as the
    way back. B's file upload stays possible later through the deposit's `source`.
- **Consequences.** Setup takes about 64 taps in one sitting of about 25 minutes (18 of them Clip Factory's; 68 and
  20 with the optional email), counting every switch between Clip Factory and Enable Banking, with BankID twice,
  because Enable Banking's Control Panel link doesn't authorise the app; after that, BankID every 90 to 180 days, as
  his bank sets (a notice 7 days before), and one tap per new payer. A payout whose bank text names no platform is never seen, and the place says
  "Nothing … reached your bank yet" rather than a number; the first deposits teach the hint list, and a missing word
  is a one-line PR. Totals start at the oldest day his bank shows (often 90 days, more within the first hour). If
  Enable Banking says creator income isn't personal use, or deactivates the app, setting the switch to `false` takes
  every screen back to "Clip Factory can't see your bank", and his stored records stay until he taps Forget my bank.
  Additive only: new sort keys `BANKCONN`, `BANKLINK#`, `DEPOSIT#`, `BANKPAYERS`, the `BANKOWNER` registry item, two
  runtime secrets, two stream filters, two Deny statements and one api env var changed in place; no new Lambda,
  table, index, role or Allow statement, and nothing that holds his data or connections is replaced.
