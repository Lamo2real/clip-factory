## Your bank

See how much money from each app really reached your bank. About 25 minutes, once · Free · Steps checked on 22 Nov
2026, for an owner in Sweden. You chose this way ("A: bank connection") on 22 Nov 2026.

It is the "Your bank" card under the place cards in Settings › Posting › Get paid, and its own page
(`/settings/posting/getpaid/bank`). Clip Factory reads your bank through Enable Banking, a company the banks let read
accounts in the EU. You use BankID on Enable Banking's page and your bank's own page. Clip Factory never asks for,
sees or keeps your bank login, your account number or your name. It only looks at money coming in.

It ships switched off. Until it is on, every screen keeps "Clip Factory can't see your bank. Look in your bank's app
to see what arrived."

### Is Enable Banking free for me?

Yes. Its restricted mode is free "for the personal use of private individuals", on accounts you link yourself. The
steps keep its three rules: the Enable Banking account and app are your own (never tap **Share**); you link only your
own private accounts (**Usage type** **personal**; a business account is left out); and nobody else uses it (never tap
**Request** next to "please request activation" or "please request unrestriction": that is for companies and costs
money). Its terms also rule out "any commercial purpose", and app money read once a day is a grey area. So the first
step is optional: a ready email that asks Enable Banking. Sending it is your choice. If they say no, tap "Stop reading"
on each bank (the money found stays); then Your bank is switched off again, and your bank's app still shows what
arrived.

### The steps

One numbered card per step, like Get paid's. In this section **bold** is only ever Enable Banking's own label, word
for word; Clip Factory's own words are in quotes. Tapping the green answer ("I'm in", "I did this") is how you finish a
step, and the next one opens. The one red button is the next step's main button, pinned at the bottom right on
phones. Enable Banking's sign-in page and the banks' pages may look a little different: look for the same words.

#### Optional: Ask Enable Banking first
"Open email" opens a ready email to Enable Banking (or copy "Their email" and "The email" into your webmail). Send
it, then tap "I asked". They say yes: do step 1. They say no: don't do the next steps (did them already? tap "Forget
my bank", or "Stop reading" on each bank to keep the money found). No answer: you can wait, or go on. It never counts
in the ring.

#### 1. Make an Enable Banking account
Tap "Open Enable Banking", type your email and tap the button under it. Open Enable Banking's email and tap its link.
Come back and tap "I'm in". **Authenticator app**: you can skip it (once it's on, it can never be turned off).

#### 2. Make your bank key
Tap "Make my bank key". Clip Factory makes a secret key and keeps it locked away. It isn't your bank login. You copy
its public part in the next step, and that part is safe to share. The step ticks itself.

#### 3. Add Clip Factory on Enable Banking
Tap "Open your Enable Banking apps" (it opens **API applications**). Under **Add a new application**, tap
**Production**, pick **Generate outside the browser and import public certificate**, and paste the "Bank key" chip in
**Public certificate in PEM format**. Tap "I did this". Still on **Sandbox**? Tap **Production**: a Sandbox app
can't read real banks. Enable Banking says no to the key? Paste the "Other bank key" chip instead.

#### 4. Fill in the app's details
Paste each Copy chip in its box: **Application name**, **Allowed redirect URLs (one per line)**, **Application
description**, **Privacy URL of the application** and **Terms URL of the application**. Type your own email in
**Email for data protection matters**, tap **Register**, then "I did this". The message **New application … has
been added.** holds your app ID: copy the whole message.

#### 5. Give Clip Factory the app ID
Paste the message in "App ID" (Clip Factory finds the ID in it) and tap "Save". Clip Factory asks Enable Banking
whether it knows your app; "Check again" asks again. Your computer saved a .pem file (Enable Banking's default)?
Better: make a new app (steps 3 and 4). Or add the file under "Have a .pem file instead?", then delete it from
Downloads and tap "I deleted it".

#### 6. Link your bank accounts
Tap "Open your Enable Banking apps" and, on your new app, **Activate by linking accounts**. Pick Sweden in
**Country**, your bank in **ASPSP** and **personal** in **Usage type**, tap **Link** and use BankID. Link every account
your app money lands in (PayPal too, with **Link accounts**). Then tap "I linked them". Don't tap **Share**, or
**Request** next to "please request activation". Payoneer, business accounts, Avanza and Nordnet can't be linked this
way.

#### 7. Connect your bank
Tap "Connect your bank" and pick a bank you linked. Use BankID again: yes, again, because this time it lets Clip
Factory read it. Then go back to Clip Factory; in another browser the page says "Done! Go back to Clip Factory. You can
close this tab." Another bank or PayPal: "Connect another bank" (up to 4).

### After setup

- Clip Factory looks at your bank once a day by itself, and when you tap "Check now" on the Your bank page (Money's
  Check now doesn't read the bank). The first read goes as far back as your bank shows, often 90 days ("Counted from 3
  Aug 2026, as far back as your bank shows.").
- When a payment may be from an app, the page asks under "Is this from an app?": one tap ("Yes, it's YouTube") or
  two ("No, another app", then the app). You never type an amount. A payer your bank names is learned after one yes;
  PayPal, Stripe, Payoneer and a name only in the payment's message are asked about every time.
- Every 90 to 180 days (your bank decides), your bank asks for BankID again. Clip Factory tells you 7 days before: tap
  "Reconnect Swedbank" and use BankID.
- "Stop reading Swedbank" stops one bank (8-second Undo); the money it found stays. "Forget my bank" removes every
  payment and bank link Clip Factory kept.

### Reached your bank

Money your bank booked and Clip Factory matched to an app is "Reached your bank", tagged "Your bank says": per app
and per money type, plus "In total" per money type. Different money types are never added together or changed, and an
app with nothing says "No money from TikTok or X reached your bank yet.", never $0. Meta pays Instagram and Facebook in
one payment, so it can count as "Instagram and Facebook together"; Whop's money is all your Whop money, Content Rewards
too. Payments waiting for your answer are never counted.

It shows on the Your bank card ("Reached your bank: kr 4 102,10 so far"), on the Your bank page, on each place's Get
paid page (under "Sent to your bank", and "Reached your bank on 28 Oct (Your bank says)" under the Google or Whop
payment it matched) and on Money ("Reached your bank, so far"). It is never added to "Sent to your bank" or the
30-day total. A payment whose bank text names no app can't be told apart, so that app keeps saying "Nothing from
Instagram reached your bank yet."

### What Clip Factory keeps

- Only money from apps: the day, the amount and which app.
- Payments it asks you about stay until you answer, about 180 days at most.
- A payer only as a secret code, never the name.
- Never your account number, your name or any other payment.
- Your bank and PayPal logins stay with them. Clip Factory never sees them.
- Enable Banking forgets your bank's answer within a minute.
- Forget my bank removes every payment, payer code and bank link Clip Factory kept.

### How many taps

From the Your bank page (Clip Factory's own in brackets): one bank 64 (18), about 25 minutes; with PayPal 80 (20);
the optional email adds 4 (2); the .pem way about 3 fewer. A question card 1 or 2, a reconnect 6 (1), Check now 1.
BankID comes twice at setup (steps 6 and 7): Enable Banking's own link "won't handle authorization on behalf of the
app".

### Sources (checked on 22 Nov 2026)

What could not be checked before the first real connect is listed under "Not verified live" in
[CONTRACTS.md §40.5.14](CONTRACTS.md#40514-not-verified-live-each-is-checked-at-his-first-connect-a-failure-becomes-a-plain-sentence-never-a-number).

- Enable Banking: [Terms of Service](https://enablebanking.com/terms/) (last updated 9 Jan 2026),
  [API applications](https://enablebanking.com/cp/applications), [sign-in](https://enablebanking.com/sign-in/),
  [linked accounts](https://enablebanking.com/docs/api/linked-accounts/),
  [quick start](https://enablebanking.com/docs/api/quick-start/), [API reference](https://enablebanking.com/docs/api/reference/),
  [API file](https://enablebanking.com/docs/api/reference/enablebanking-api.yaml), the bank list
  (`enablebanking.com/api/aspsps`, SE), [Privacy Notice](https://tilisy.enablebanking.com/terms) (7 Mar 2025),
  [EBA register](https://euclid.eba.europa.eu/register/pir/view/PSD_AISP/FI_FIN_FSA!29884997)
- EU rules: [Regulation (EU) 2018/389](https://eur-lex.europa.eu/eli/reg_del/2018/389/oj) (Article 36(5)(b)),
  [Regulation (EU) 2022/2360](https://publications.europa.eu/resource/celex/32022R2360)
- Telling payments apart: Google's [test payment](https://support.google.com/adsense/answer/2975858) and
  [payment days](https://support.google.com/adsense/answer/7164703),
  [Stripe's statement name](https://docs.stripe.com/connect/payout-statement-descriptors.md), Whop's
  [troubleshoot payouts](https://docs.whop.com/manage-your-business/manage-payouts/troubleshoot-payouts.md) and
  [payout](https://docs.whop.com/api-reference/payouts/payout.md)
