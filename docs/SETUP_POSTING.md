# Set up posting

Clip Factory can post your clips by itself to **YouTube, TikTok, Instagram, Facebook and X**. For that, each of the
five needs to be set up **once**. This page is the same list of steps the app shows you in **Settings › Posting ›
Set up posting**, word for word in meaning and in the same order, so you can read ahead or print it.

**Steps checked on 19 Nov 2026** against each platform's own help pages (the list is at the
[end of this page](#research-sources-checked-on-16-nov-2026), with what changed on 19 Nov 2026 below it). Platforms sometimes rename a button. When that happens, the app
shows an "If you see…" hint, and the [maintainer notes](#for-maintainers-keeping-the-app-and-this-page-in-step) say how to
update both.

You never write code. You only use the Clip Factory app and the platforms' own websites.

## The setup list

Do each one once. After that Clip Factory posts by itself. You can do them in any order and stop at any time: the app
remembers where you were and opens the next step for you.

| # | Platform | Time | Cost | What you need first | Good to know |
|---|---|---|---|---|---|
| 1 | [YouTube](#youtube) | about 20 minutes | Free | A Google account with a YouTube channel | Posts are public straight away. |
| 2 | [TikTok](#tiktok) | about 40 minutes, then TikTok checks your app (days) | Free | A TikTok account | Posts may stay **"Only me"** for a long time. TikTok often says no to apps that only one person uses. |
| 3 | [Instagram](#instagram) | about 25 minutes | Free | An Instagram **Creator** or **Business** account linked to a Facebook **Page**, and a Facebook account | Posts are public. |
| 4 | [Facebook](#facebook) | about 25 minutes | Free | A Facebook **Page** you fully control | Reels may be seen only by you until the app is **Live**. |
| 5 | [X](#x) | about 15 minutes | **Costs a little**: about $1.50 for 100 clips | An X account and a grown-up's card | X charges for every post. Clip Factory stops at $10 a month. |

The ring at the top of Set up posting says how many are ready, for example **2 of 5 ready**. A **Set up posting**
list also stays at the top right of every page (a small pill on phones) with **Set up** and **Skip** for each
platform. It goes away when each one is ready or skipped, and you can always skip one or bring it back here in
Settings.

## How every setup works

Every platform page has the same four parts:

1. **Get ready**: what your account needs before you start.
2. **Make your {Platform} key**: a few clicks on the platform's developer website. You do this once.
3. **Connect**: one big button. You say yes on the platform and come back to Clip Factory.
4. **Go public**: what the platform still has to allow, and how it is going.

Each step is a big numbered card. The numbers run on from one part to the next. A card has only what that step needs:

| On the card | What it does |
|---|---|
| **Open {site}** | Opens the right page of the platform in a new tab. Come back to the Clip Factory tab after. |
| **Copy** | Copies a value (a name, a web address). You see **Copied!**. Then paste it on the platform. |
| A paste box with **Paste** | Where you put a key from the platform. The box checks it while you type and says what is wrong. |
| An upload box | Only on TikTok: where you drop the file TikTok gives you. |
| **If you see…** | What to do when the platform looks a little different. |
| **I did this** | Press it when you finished the step. The next step opens. |

Some steps tick themselves (for example when your keys are saved or when you are connected). Steps marked **(only if
you need it)** are extra and do not count in the ring.

There is always **one** vermilion-red button on the screen: it is the next thing to press.

**Use a computer.** The developer websites work best on a computer. Use the same browser for every step, and keep
Clip Factory open in one tab and the platform in another.

### The values Clip Factory gives you

You never type these. Every step that needs one has a **Copy** button. They are listed here so a grown-up can check
them. `{app}` is your Clip Factory address and `{hooks}` is its sign-in return address; the app fills in the real ones.

| Name on the card | What it is |
|---|---|
| App name | `Clip Factory` (Facebook: `Clip Factory Pages`) |
| Description | "Clip Factory turns my gameplay recordings into short vertical clips and posts them to my own accounts when I press Keep." |
| Website | `{app}/about.html` |
| Website prefix (TikTok) | `{app}/` |
| Privacy Policy | `{app}/legal/privacy.html` |
| Terms of Service | `{app}/legal/terms.html` |
| Data deletion instructions | `{app}/legal/privacy.html#delete` |
| App domain | the host of `{app}`, for example `dxxxx.cloudfront.net` |
| Return address domain | the host of `{hooks}`, for example `xxxx.execute-api.eu-north-1.amazonaws.com` |
| Redirect URI (return address) | `{hooks}/oauth/{platform}/callback`, for example `…/oauth/youtube/callback`. Exact, no slash at the end. |
| Permissions (scopes) | the list for that platform (YouTube: 3 lines) |
| Your email | the email you sign in to Clip Factory with |
| X use case | "Post my own short video clips to my own X account and read their view and like counts in my personal Clip Factory app." |
| TikTok review text | See [step 13 of TikTok](#13-fill-in-app-review-then-save). |

The About, Privacy and Terms pages live on your Clip Factory address on purpose: TikTok checks that the website is
yours, and Google lists every web address your app uses.

---

## YouTube

About 20 minutes · Free · Steps checked on 19 Nov 2026.

| # | Step | Part |
|---|---|---|
| 1 | Have a YouTube channel | Get ready |
| 2 | Use a computer | Get ready |
| 3 | Open Google Cloud | Make your YouTube key |
| 4 | Make a project | Make your YouTube key |
| 5 | Turn on YouTube Data API v3 | Make your YouTube key |
| 6 | Turn on YouTube Analytics API | Make your YouTube key |
| 7 | Start Google Auth Platform | Make your YouTube key |
| 8 | Fill in Branding | Make your YouTube key |
| 9 | Add the 3 permissions | Make your YouTube key |
| 10 | Publish the app | Make your YouTube key |
| 11 | Make the key | Make your YouTube key |
| 12 | Paste the key here | Make your YouTube key |
| 13 | Connect YouTube | Connect |
| 14 | Pick who can see your clips | Go public |
| 15 | Post at least every 6 months (only if you need it) | Go public |
| 16 | Only if you post over 100 a day (only if you need it) | Go public |

### Part 1: Get ready

#### 1. Have a YouTube channel
- Open **youtube.com/account**.
- No channel yet? Press your profile picture, then **Create a channel**.
- Shorts are tall videos up to 3 minutes long.
- A Short over 1 minute with copyrighted music gets blocked. Keep music clips under 60 seconds.

#### 2. Use a computer
- The developer websites work best on a computer. Use the same browser for every step.
- Sign in to Google with the account that owns the channel.

### Part 2: Make your YouTube key

#### 3. Open Google Cloud
- Press **Open Google Cloud** (console.cloud.google.com).
- First time? Pick your country, tick the box, press **Agree and continue**.
- You do not need a card. Skip any free-trial offer.

#### 4. Make a project
- Press **Open** (console.cloud.google.com/projectcreate).
- Project name: press **Copy** next to App name and paste it.
- Location: **No organization**. Press **Create**.
- Wait for the bell. Check that "Clip Factory" is picked at the top.

#### 5. Turn on YouTube Data API v3
- Press **Open** (…/apis/library/youtube.googleapis.com). Press **Enable**.
- If you see **Manage**, it is already on. Press **I did this**.

#### 6. Turn on YouTube Analytics API
- Press **Open** (…/apis/library/youtubeanalytics.googleapis.com). Press **Enable**.
- If you see **Manage**, it is already on.

#### 7. Start Google Auth Platform
- Press **Open** (…/auth/overview). Press **Get started**.
- App name: copy it. User support email: pick yours. Press **Next**.
- Audience: **External**. Press **Next**.
- Contact email: copy yours. Press **Next**.
- Tick the User Data Policy box. Press **Continue**, then **Create**.

#### 8. Fill in Branding
- Press **Open** (…/auth/branding).
- Under **App domain**, copy the Website, Privacy Policy and Terms of Service addresses into the three boxes
  (home page, privacy policy link, terms of service link).
- Press **Add domain** two times. Copy in the App domain, then the Return address domain.
- Developer contact: copy your email. Leave the logo empty. Press **Save**.
- If you see an error about a domain: tell Clip Factory support. A custom domain fixes it.

#### 9. Add the 3 permissions
- Press **Open** (…/auth/scopes). Press **Add or remove scopes**.
- Scroll down to **Manually add scopes**. Copy the 3 permissions and paste them, one per line.
- Press **Add to table**, then **Update**, then **Save**.
- "Your sensitive scopes" is normal. Do not worry.

#### 10. Publish the app
- Press **Open** (…/auth/audience). Press **Publish app** and confirm.
- It must say **In production**. In **Testing**, YouTube stops working after 7 days.
- Do NOT press **Prepare for verification**. You do not need it.
- Clip Factory shows a warning on YouTube until you tick this step.

#### 11. Make the key
- Press **Open** (…/auth/clients). Press **Create client**.
- Application type: **Web application**. Name: copy the App name.
- Under **Authorized redirect URIs**, press **Add URI**. Copy the Redirect URI and paste it.
- Press **Create**.
- Copy BOTH values now, or press **Download JSON**. Google shows the secret only once.

#### 12. Paste the key here
- Paste the **Client ID** and the **Client secret** in the two boxes.
- Or drop the key file Google gave you here: both boxes fill in. (Or press **Use the key file from Google**.)
- Press **Save keys**. This step ticks itself.
- Lost the secret? Open the client, press **Add secret**, use the new one. Then **Disable** the old one.

### Part 3: Connect

#### 13. Connect YouTube
- Press the big **Connect YouTube** button.
- Pick your Google account, then your channel.
- If you see "Google hasn't verified this app": press **Advanced**, then **Go to … (unsafe)**. It is your own app, so this is normal. It may show a web address instead of the name.
- Tick every box (or **Select all**). Press **Continue**.
- You come back to Clip Factory with confetti and "Connected as …". This step ticks itself.
- If you see `redirect_uri_mismatch`: wait 5 minutes and press Connect again. Still wrong? Do step 11 again with the **Copy** button.

### Part 4: Go public

#### 14. Pick who can see your clips
- Pick one inside the card: **Everyone**, **Only people with the link** or **Only me**.
- It starts on **Everyone**. YouTube asks every app to let you choose.
- Status: "Works now. Your clips go up for everyone."

#### 15. Post at least every 6 months
- Only if you need it. Google deletes keys that are not used for 6 months.
- Google emails you 30 days before. Pressing **Connect again** keeps them alive.

#### 16. Only if you post over 100 a day
- Only if you need it. Most people never post that many.
- For more, press **Open Google's ask-for-more form** (YouTube's **Audit and Quota Extension Form**). You do not need it to start.

### If YouTube says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect YouTube to try again." | Press **Connect YouTube**. |
| "That took too long. Press Connect YouTube again." | Press **Connect YouTube** again. You have 10 minutes each time. |
| "The key does not work. Copy the Client ID and secret again (step 11)." | Do step 11 and step 12 again. |
| "The return address does not match. Copy it again in step 11." | Do step 11 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Press **Connect YouTube** and tick every box. |
| "This Google account has no YouTube channel. Make one first (step 1)." | Do step 1, then connect again. |
| "YouTube did not answer. Try again in a few minutes." | Wait, then press **Connect YouTube**. |

---

## TikTok

About 40 minutes, plus the time TikTok takes to check your app · Free · Steps checked on 19 Nov 2026.

**Please read first.** Until TikTok checks and approves the app, it can only post to a **private** account, and every
post is **"Only me"**. TikTok often says no to apps that only one person uses. If it says no, Clip Factory still posts
to TikTok, but only you can see those posts, and TikTok gives no numbers for them.

| # | Step | Part |
|---|---|---|
| 1 | Have your TikTok account | Get ready |
| 2 | Use a computer | Get ready |
| 3 | Make your TikTok private for now | Get ready |
| 4 | Make a TikTok developer account | Make your TikTok key |
| 5 | Make an organization | Make your TikTok key |
| 6 | Create the app | Make your TikTok key |
| 7 | Fill in App details | Make your TikTok key |
| 8 | Choose Web | Make your TikTok key |
| 9 | Add 2 products | Make your TikTok key |
| 10 | Paste the return address | Make your TikTok key |
| 11 | Turn on Direct Post | Make your TikTok key |
| 12 | Add 2 permissions | Make your TikTok key |
| 13 | Fill in App review, then Save | Make your TikTok key |
| 14 | Prove the website is yours | Make your TikTok key |
| 15 | Paste Client key and secret | Make your TikTok key |
| 16 | Make a Sandbox for testing | Connect |
| 17 | Add yourself as a test user | Connect |
| 18 | Verify the website in Sandbox too | Connect |
| 19 | Use the Sandbox keys | Connect |
| 20 | Connect TikTok | Connect |
| 21 | Record the real demo video | Go public |
| 22 | Ask TikTok to check the app | Go public |
| 23 | When it says Live | Go public |
| 24 | Ask to post publicly | Go public |
| 25 | Make your account public again | Go public |

### Part 1: Get ready

#### 1. Have your TikTok account
- Use the TikTok account your clips should go on.

#### 2. Use a computer
- The developer websites work best on a computer. Use the same browser for every step.

#### 3. Make your TikTok private for now
- In the TikTok app, press **Profile**, then the menu (three lines).
- Press **Settings and privacy**, then **Privacy**. Turn on **Private account**.
- Until TikTok checks the app, it only posts to private accounts.

### Part 2: Make your TikTok key

TikTok's app page is one long page with one **Save** button. **Save stays off until App review has its text and a
video.** So fill in steps 7 to 13 first, and press Save only in step 13.

#### 4. Make a TikTok developer account
- Press **Open** (developers.tiktok.com/signup). Press **Sign up**, or **Log in** if you have one.
- Accept the terms.

#### 5. Make an organization
- Press **Open** (the Organizations page). Press **Add organization**.
- Name: copy the App name. Press **Create**.

#### 6. Create the app
- Press your profile icon, then **Manage apps**, then **Connect an app**.
- Pick your organization. Press **Confirm**.

#### 7. Fill in App details
- Press **Download the icon** in Clip Factory. Upload that picture as the app icon.
- App name: copy it. Category: pick the closest one.
- Description: copy it.
- **Terms of Service URL**: copy it. **Privacy Policy URL**: copy it.
- Don't press **Save** yet. It stays off until **App review** has its text and a video (step 13).

#### 8. Choose Web
- Under **Platforms**, tick **Web** only. Not **Desktop**, not Android or iOS.
- **Website URL**: copy the Website.

#### 9. Add 2 products
- Press **Add products**. Add **Login Kit** and **Content Posting API**.
- Nothing else. There is no **Display API** to add now: its permissions come with Login Kit.

#### 10. Paste the return address
- Open the **Login Kit** settings.
- Copy the return address and paste it into **Redirect URI** for **Web**.

#### 11. Turn on Direct Post
- Open the **Content Posting API** settings. Turn on **Direct Post**.
- If you see a switch with "Direct Post" in its name, turn it on.

#### 12. Add 2 permissions
- In **Login Kit**, open **Scopes** (TikTok's word for permissions). Press **Add scopes**.
- Tick **video.list** (your views) and **user.info.stats** (your followers, for the money tile). Press **Add**.
- Now these must be there: user.info.basic, video.publish, video.list, user.info.stats.
- video.upload may be there too. Leave it.

#### 13. Fill in App review, then Save
- Open **App review**. Copy the TikTok review text from Clip Factory and paste it. It says, one line per permission:
  "user.info.basic (Login Kit): connect my TikTok and show my name and picture in Clip Factory.
  video.publish: post clips I approved with Keep straight to my own TikTok (Direct Post).
  video.upload: comes with Content Posting API. Clip Factory does not ask for it; it only uses Direct Post.
  video.list: show the views and likes of my own posts on my Clip Factory dashboard.
  user.info.stats: show my follower and like totals on my Clip Factory money tile, only after I say OK."
- Record your screen for a few seconds: the About page, then the setup page. Upload that video.
- Now press **Save**. You swap in the real demo video later (step 21).
- Save still won't press? App review needs both: the text and a video.

#### 14. Prove the website is yours
- Open **URL properties**, press **Verify properties**. Check **Production** is picked.
- Pick **URL prefix**, not Domain.
- Copy the Website prefix and paste it. Press **Verify**.
- Download TikTok's file. Drop it in the upload box in Clip Factory. This step ticks itself.
- Back on TikTok, press **Verify**.

#### 15. Paste Client key and secret
- Open **Credentials**. Press the copy icon next to **Client key**. Paste it in Clip Factory.
- Do the same for **Client secret**.
- Press **Save keys**. This step ticks itself.

### Part 3: Connect

TikTok only lets you test in a **Sandbox** until it approves the app. So you connect in a Sandbox first. Your posts
stay private until TikTok approves the app.

#### 16. Make a Sandbox for testing
- At the top, switch **Production** to **Sandbox**. Press **Create Sandbox**.
- Give it a name. Pick "clone Production". Press **Confirm**, then **Apply changes**.

#### 17. Add yourself as a test user
- Open **Sandbox settings**, then **Target users**. Press **Add account**.
- Log in with your TikTok account and accept.
- It can take up to an hour. Refresh the page to check.

#### 18. Verify the website in Sandbox too
- Do step 14 again, with **Sandbox** picked.
- Drop that file in Clip Factory too.

#### 19. Use the Sandbox keys
- If you see a different **Client key** in the Sandbox, paste those keys in Clip Factory for now.

#### 20. Connect TikTok
- Press the big **Connect TikTok** button.
- Log in. Check that it says Clip Factory. Leave every switch on.
- Press **Authorize**. You come back with confetti. This step ticks itself.
- Status: "Works now, but your TikTok posts stay private until TikTok says yes."

### Part 4: Go public

#### 21. Record the real demo video
- Record your screen while you use Clip Factory, connected in the Sandbox. Show:
  open Clip Factory, press **Connect TikTok**, TikTok's **Authorize** screen,
  press **Keep** on a clip, pick in the **Post to TikTok** sheet, and Keep,
  then the post arriving on your TikTok.
- You can send up to 5 videos, 50 MB each.

#### 22. Ask TikTok to check the app
- Switch back to **Production**. Open **App review**.
- Check the review text from step 13 is there. Swap in the real demo video.
- Press **Save**, then **Submit for review**.
- In Clip Factory, pick what TikTok says: **Draft**, **In review**, **Live** or **Not approved**.
- Not approved? Read **Review comments**, fix what they say, and submit again.
- While it is in review: "TikTok is checking your app. This can take days."

#### 23. When it says Live
- If the Production keys are different from the Sandbox ones, paste them in Clip Factory.
- Then press **Connect again**.

#### 24. Ask to post publicly
- Press **Open** (developers.tiktok.com/application/content-posting-api) and fill in the form.
- Until it passes, every post is "Only me".
- TikTok may say no to a tool only you use. Then your posts stay private.

#### 25. Make your account public again
- Only after the form in step 24 passes: turn **Private account** off again.

### If TikTok says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect TikTok to try again." | Press **Connect TikTok**. |
| "That took too long. Press Connect TikTok again." | Press **Connect TikTok** again. |
| "The key does not work. Copy the Client key and secret again (step 15)." | Do step 15 again (in the Sandbox: step 19). |
| "The return address does not match. Copy it again in step 10." | Do step 10 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Do step 12, then connect again and leave every switch on. |
| "Make your TikTok account private (Setup step 3), then press Try again." | Do step 3, then press **Try again** on the clip. |
| "TikTok did not answer. Try again in a few minutes." | Wait, then press **Connect TikTok**. |
| "Finish the TikTok review steps to post outside the Sandbox." | Do steps 21 to 23. |

**Every time you press Keep** with TikTok connected, a **Post to TikTok** sheet opens first. Pick who can see it on
TikTok (there is no default, TikTok's rule), choose the Comments, Duet and Stitch switches, and say if the clip is
promotional. Then Keep. TikTok can take a few minutes to process your clip.

If a clip says "Pick who can see it on TikTok again, then press Try again.", press **Try again** on the clip. The
**Post to TikTok** sheet opens first. Pick again, then press the vermilion-red button on the sheet.

---

## Instagram

About 25 minutes · Free · Steps checked on 19 Nov 2026. Uses Meta's Instagram API with Facebook Login.

Instagram and Facebook each get **their own** Meta app. Some steps look the same twice. That is on purpose: it keeps
the two from getting in each other's way.

| # | Step | Part |
|---|---|---|
| 1 | Make Instagram a pro account | Get ready |
| 2 | Link Instagram to a Facebook Page | Get ready |
| 3 | Use a computer | Get ready |
| 4 | Business portfolio, if Meta asks (only if you need it) | Get ready |
| 5 | Become a Meta developer | Make your Instagram key |
| 6 | Create the app | Make your Instagram key |
| 7 | Fill in Basic settings | Make your Instagram key |
| 8 | Make the Instagram login setup | Make your Instagram key |
| 9 | Double-check the return address (only if you need it) | Make your Instagram key |
| 10 | Paste the 3 values | Make your Instagram key |
| 11 | Connect Instagram | Connect |
| 12 | Post one test clip | Go public |

### Part 1: Get ready

#### 1. Make Instagram a pro account
- In the Instagram app, press your picture, then the menu.
- Press **Account type and tools**, then **Switch to professional account**.
- Pick **Creator** or **Business**. Personal accounts cannot connect.

#### 2. Link Instagram to a Facebook Page
- In the Instagram app, press **Edit profile**, then **Page** (under Public business information).
- Pick your Facebook Page, or press **Create a Facebook Page**.
- No Page yet? Make one first in the [Facebook setup, step 1](#1-have-a-facebook-page).
- If you see no **Page** line in Edit profile: on Facebook, open your Page, then **Settings**, then **Linked
  accounts**, then **Instagram**. Press **Connect account**.
- If you see **Manage connection** on Facebook (on your Page, after **Edit profile**): your Instagram is already
  linked. Check the Instagram name, close it, and press **I did this**. Never press **Disconnect**.
- If **Manage connection** shows the wrong Instagram: press **Disconnect**, then **Connect account** and log in to
  your clip Instagram.
- "People who help manage your Page" on that sheet: leave those choices as they are. They only matter if other
  people help run the Page.

#### 3. Use a computer
- The developer websites work best on a computer. Use the same browser for every step.
- Log in to facebook.com with the Facebook account that will own the app.
- Wrong account? Log out first.

#### 4. Business portfolio, if Meta asks
- Only if you need it: Meta asks for a portfolio, or your Instagram is already in one. Otherwise skip this step.
- Press **Open** (business.facebook.com). Press **Create a business portfolio**.
- Type a name, your name and your email. Press **Create**.
- Press **Settings**, then **Accounts**, then **Instagram accounts**. Press **Add** and log in to Instagram.
- Already in a portfolio? Use that one.

### Part 2: Make your Instagram key

#### 5. Become a Meta developer
- Press **Open** (developers.facebook.com/async/registration). Press **Next**.
- Type the codes Meta sends you. Pick **Creator**.

#### 6. Create the app
- Press **Open** (developers.facebook.com/apps). Press **Create app**.
- App name: copy it. Type your email. Press **Next**.
- Use case: **Manage messaging & content on Instagram**. Press **Next**.
- Pick your portfolio, or skip it. Press **Next**, then **Go to dashboard**.
- Never ask Meta for a review. You do not need one.

#### 7. Fill in Basic settings
- Press **App settings**, then **Basic**.
- **Privacy Policy URL**: copy it. **Terms of Service URL**: copy it.
- Under **User data deletion**, **Data deletion instructions URL**: copy it.
- Pick a **Category**. Press **Save changes**.

#### 8. Make the Instagram login setup
- Press **Use cases**, then **Customize** next to Instagram. Open the tab **API setup with Facebook login**.
- Press **Create new configuration** (under Facebook Login for Business › Configurations). Token type: **User access
  token**, the longest expiry. Assets: your Page and Instagram account.
- Press **Edit permissions**. Tick instagram_basic, instagram_content_publish, **instagram_manage_insights** (it is not
  ticked by itself), pages_show_list and pages_read_engagement.
- If you see instagram_manage_messages: leave it ticked.
- Press **Use this configuration**.
- **Redirect URL**: copy the Redirect URI (the return address). Press **Save**.

#### 9. Double-check the return address
- Only if you need it.
- If you see **Facebook Login for Business**, then **Settings**: put the Redirect URI in **Valid OAuth Redirect URIs**.
- Turn **Enforce HTTPS** on. Press **Save changes**.
- No such page? Skip this step.

#### 10. Paste the 3 values
- **App ID**: copy and paste it.
- **App secret**: press **Show** (Facebook may ask your password), copy and paste it.
- **Configuration ID**: copy and paste it. Or paste the whole **Login URL**: Clip Factory finds the ID.
- Press **Save keys**. This step ticks itself.

### Part 3: Connect

#### 11. Connect Instagram
- Press the big **Connect Instagram** button.
- Log in with the same Facebook account. Pick your portfolio if asked, then your Instagram. Confirm.
- Several accounts? Pick the right one in Clip Factory.
- Your Instagram is not in the list? It is still personal (step 1), not linked to a Page (step 2), or in another
  portfolio (step 4).

### Part 4: Go public

#### 12. Post one test clip
- Keep one clip. Instagram may take a few minutes to show it.
- Numbers can take 2 days.
- Status: "Works now."
- If you see your Reels missing for other people: tell Clip Factory support; Meta may want the app Live.
- If Facebook asks you to confirm who runs the Page (Page Publishing Authorization): do it. Instagram will not post
  until you do.

### If Instagram says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect Instagram to try again." | Press **Connect Instagram**. |
| "That took too long. Press Connect Instagram again." | Press **Connect Instagram** again. |
| "The key does not work. Copy the App ID, App secret and Configuration ID again (step 10)." | Do step 10 again. |
| "The return address does not match. Copy it again in step 8." | Do step 8 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Do step 8, then connect again. |
| "Instagram did not show a pro account. Do steps 1 and 2, then connect again." | Do steps 1 and 2, then connect again. |
| "Instagram did not answer. Try again in a few minutes." | Wait, then press **Connect Instagram**. |

---

## Facebook

About 25 minutes · Free · Steps checked on 19 Nov 2026. Posts Reels to your Facebook **Page**, with Facebook Login
for Business.

| # | Step | Part |
|---|---|---|
| 1 | Have a Facebook Page | Get ready |
| 2 | Use a computer | Get ready |
| 3 | Turn on Meta for developers | Make your Facebook key |
| 4 | Create the app | Make your Facebook key |
| 5 | Pick one use case | Make your Facebook key |
| 6 | Finish the app | Make your Facebook key |
| 7 | Turn on Page permissions | Make your Facebook key |
| 8 | Fill in Basic settings | Make your Facebook key |
| 9 | Paste the return address | Make your Facebook key |
| 10 | Make a login configuration | Make your Facebook key |
| 11 | Paste the 3 values | Make your Facebook key |
| 12 | Connect Facebook | Connect |
| 13 | Make the app Live | Go public |

### Part 1: Get ready

#### 1. Have a Facebook Page
- Press **Open** (facebook.com/pages/?category=your_pages).
- No Page? Press **Create new Page**.
- A normal profile cannot post Reels through apps. You need a Page.
- You need **Content** or **Full control** access on the Page.
- Then tap your picture and switch back to your own profile. Do not change Page settings.
- If you see **Manage connection** after **Edit profile** on your Page: your Instagram is already linked to this
  Page. Close it. Never press **Disconnect**. Press **I did this**.
- If you see **People who help manage your Page**: leave those choices as they are.

#### 2. Use a computer
- The developer websites work best on a computer. Use the same browser for every step.

### Part 2: Make your Facebook key

#### 3. Turn on Meta for developers
- Open developers.facebook.com. Press **Log in** or **Get Started**.
- Accept, then check your phone number or email.
- Already did this for Instagram? Just press **I did this**.

#### 4. Create the app
- Press **Open** (developers.facebook.com/apps/creation).
- App name: copy "Clip Factory Pages". Never put Facebook, Meta or Instagram in the name.
- Type your email. Press **Next**.

#### 5. Pick one use case
- Tick only **Manage everything on your Page**.
- Do not tick the Instagram one. Do not tick **Authenticate and request data from users with Facebook Login**.
- Use cases cannot be removed later. Press **Next**.

#### 6. Finish the app
- Business: pick your portfolio, or **I don't want to connect a business portfolio yet**.
- Press **Next**, **Next**, then **Go to dashboard**.

#### 7. Turn on Page permissions
- On the **Dashboard**, press **Customize the Manage everything on your Page use case**.
- Press **Add** next to pages_read_engagement, pages_manage_posts, read_insights and pages_manage_engagement.
- pages_show_list and business_management are already there. Press **Ready to test**.

#### 8. Fill in Basic settings
- Press **App settings**, then **Basic**.
- **App domains**: copy the App domain. **Privacy Policy URL** and **Terms of Service URL**: copy them.
- **Data deletion instructions URL**: copy it. Pick a **Category**.
- **App icon**: press **Download the icon** in Clip Factory and upload it.
- In the EU: **Data Protection Officer** is your name and email.
- Press **+ Add platform**, then **Website**. **Site URL**: copy the Website.
- Press **Save changes**.

#### 9. Paste the return address
- Open **Facebook Login for Business**, then **Settings**.
- Set **Client OAuth login**, **Web OAuth login** and **Enforce HTTPS** to Yes. Turn Strict Mode on.
- **Valid OAuth Redirect URIs**: copy the Redirect URI. Press **Check URI**, then **Save changes**.
- Not in the menu? Look under **Use cases**, then **Customize**, or **Add product**.
- If you see **Deauthorize Callback URL** or **Data Deletion Request URL** boxes: leave them empty.

#### 10. Make a login configuration
- Open **Facebook Login for Business**, then **Configurations**. Press **+ Create configuration** (not a template).
- Name: copy the App name. If asked, pick **General**.
- Token: **User access token**, the longest expiry. Assets: **Pages**.
- Permissions: pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement, read_insights, business_management.
- Press **Create**.

#### 11. Paste the 3 values
- Paste the **App ID**, the **App secret** and the **Configuration ID**.
- Press **Save keys**. This step ticks itself.

### Part 3: Connect

#### 12. Connect Facebook
- Press the big **Connect Facebook** button. Press **Continue**.
- Tick the Page your clips go on.
- Leave every switch ON. If one is off, Facebook gives Clip Factory nothing.
- Press **Save**, then **Got it**.
- Several Pages? Pick the right one in Clip Factory.

### Part 4: Go public

#### 13. Make the app Live
- In the left menu, press **Publish**. Check the list, then press **Publish** at the bottom right.
- No **Publish** in the menu? Turn the **App Mode** switch to **Live**.
- Facebook Reels from apps must be 3 to 90 seconds long, 9:16, at least 540x960. Meta allows 30 app posts a day per
  Page.
- Something missing? Go back to step 8.
- If Meta asks for **App Review** first: your Reels stay visible only to you for now. Tell Clip Factory support.
- Status before this step: "Works now, but only you can see your Facebook Reels until the app is Live."

### If Facebook says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect Facebook to try again." | Press **Connect Facebook**. |
| "That took too long. Press Connect Facebook again." | Press **Connect Facebook** again. |
| "The key does not work. Copy the App ID, App secret and Configuration ID again (step 11)." | Do step 11 again. |
| "The return address does not match. Copy it again in step 9." | Do step 9 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Press **Connect Facebook** and leave every switch on. |
| "Facebook did not show a Page you control. Do step 1, then connect again." | Do step 1, then connect again. |
| "Facebook did not answer. Try again in a few minutes." | Wait, then press **Connect Facebook**. |

---

## X

About 15 minutes · **Costs a little**: X charges $0.015 per clip, about $1.50 for 100 clips · Steps checked on 19 Nov
2026.

Clip Factory stops posting to X at **$10 a month**, and never puts links in X posts (a link costs $0.20).

| # | Step | Part |
|---|---|---|
| 1 | Use the X account your clips go on | Get ready |
| 2 | Use a computer | Get ready |
| 3 | Ask a grown-up for a card | Get ready |
| 4 | Sign in to the X Developer Console | Make your X key |
| 5 | Buy a few credits | Make your X key |
| 6 | Create the app | Make your X key |
| 7 | Open the sign-in settings | Make your X key |
| 8 | Pick Read and write | Make your X key |
| 9 | Paste the addresses | Make your X key |
| 10 | Paste Client ID and Secret | Make your X key |
| 11 | Connect X | Connect |
| 12 | Keep a few credits | Go public |

### Part 1: Get ready

#### 1. Use the X account your clips go on
- Your email must be confirmed. X may ask for a phone number.
- The account must not be protected, or only your followers see the clips.

#### 2. Use a computer
- The developer websites work best on a computer. Use the same browser for every step.

#### 3. Ask a grown-up for a card
- X charges a little for every post.
- You need a normal credit or debit card. Prepaid cards get no bonus.

### Part 2: Make your X key

#### 4. Sign in to the X Developer Console
- Press **Open** (console.x.com). Sign in with the same X account.
- Accept the **Developer Agreement and Policy**.
- In the use-case box, copy the X use case.

#### 5. Buy a few credits
- Open **Billing**, then **Credits**. Save the card.
- Buy the smallest amount. Set a spending limit of $10.
- Leave auto-recharge OFF. (X matches your first auto-recharge up to $50. Clip Factory still says leave it off,
  so a busy month can never spend more than you planned.)
- X may add $20 for free after the first purchase.

#### 6. Create the app
- Open **Apps**. Press **Create App** (or **New App**).
- Name: copy the App name. Taken? Add your name.
- Description: copy the X use case. Press **Create**.
- Clip Factory does NOT need the API Key, API Secret, Bearer Token or Access Token.
- If the box shows a **Client ID** and **Client Secret**, paste them now (step 10). Then press **Close**.

#### 7. Open the sign-in settings
- Open your app, then **Keys & Tokens**.
- Next to **User authentication settings**, press **Set up** (or **Edit**).

#### 8. Pick Read and write
- **App permissions**: **Read and write**.
- **Type of App**: **Web App, Automated App or Bot**.

#### 9. Paste the addresses
- **Callback URI / Redirect URL**: copy the Redirect URI.
- **Website URL**: copy the Website.
- If asked: **Terms of service** and **Privacy policy**: copy them.
- Press **Save Changes**.

#### 10. Paste Client ID and Secret
- Copy the **Client ID** and the **Client Secret**. X shows the secret only once.
- Paste them here and press **Save keys**. Then press **Close** on X.
- Lost it? Open **Keys & Tokens** and press **Regenerate**.

### Part 3: Connect

#### 11. Connect X
- Press the big **Connect X** button.
- Check it is the right account. Press **Authorize** (it may say **Authorize app**).
- If you see "Callback URL not approved": do step 9 again with the **Copy** button.

### Part 4: Go public

#### 12. Keep a few credits
- Status: "Works now. Posts are public straight away."
- If the credits run out: "Your X credits ran out. Buy more in **Billing** › **Credits**."

### If X says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect X to try again." | Press **Connect X**. |
| "That took too long. Press Connect X again." | Press **Connect X** again. |
| "The key does not work. Copy the Client ID and Client Secret again (step 10)." | Do step 10 again. |
| "The return address does not match. Copy it again in step 9." | Do step 9 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Do step 8, then connect again. |
| "X did not answer. Try again in a few minutes." | Wait, then press **Connect X**. |
| "Clip Factory stopped X at your $10 limit this month." | Wait for next month, or ask a grown-up to raise the limit. |

---

## After setup

**When it's done**, the bottom of each platform page shows your account picture and name, and three buttons:

- **Check it** asks the platform if your keys and connection still work, and says so in one sentence.
- **Connect again** signs in again with the same keys. Use it when the app says "Needs you: connect again".
- **Disconnect** removes the connection. A toast says "Disconnecting… Undo" for 8 seconds; press **Undo** to keep it.
  Your keys stay saved, so **Connect again** works later.
  On **Facebook**, Disconnect makes Clip Factory forget your Page, but Facebook still lists the app. To remove it
  there too: open Facebook, go to **Settings & privacy** › **Settings** › **Business integrations**, find your app
  and press **Remove**.

**Clips you kept before a platform was connected** stay "Waiting for connection" for that platform. They are not
posted by themselves after you connect. New clips you keep are posted.

**If a clip did not post**, its page says why in one sentence and what to press, for example "Connect YouTube again
in Settings › Posting › Set up posting, then press Try again."

## For maintainers: keeping the app and this page in step

- The in-app steps are data files, one per platform: `web/src/setup/{youtube,tiktok,instagram,facebook,x}.ts`. The
  contract for their ids, titles, parts and wording rules is
  [CONTRACTS.md §17.2](CONTRACTS.md#172-step-content-one-data-file-per-platform-websrcsetupyoutubetiktokinstagramfacebookxts).
- This page must match them: under each `## {Platform}` heading, every step title appears with the same number, in
  the same part. The web test `setup-docs.test.ts` checks it ([TESTING.md](TESTING.md#posting-setup)).
- When a platform changes a button name: change the step in the data file **and** here, keep the step id, set
  `checkedOn` and the "Steps checked on" date on both, and add the source to the list below. If you are not sure, add
  an "If you see…" hint instead of changing the main sentence.
- Why it is built this way (bring your own keys, two Meta apps, same-tab Connect):
  [ADR-33](DECISIONS.md#adr-33-posting-setup-bring-your-own-keys-with-a-guided-list-per-platform) to
  [ADR-37](DECISIONS.md#adr-37-about-privacy-and-terms-on-the-apps-own-domain). How keys and
  tokens are kept: [SECURITY.md](SECURITY.md#platform-keys-and-tokens). How Connect and posting run:
  [ARCHITECTURE.md flow 16](ARCHITECTURE.md#16-set-up-posting-connect-and-real-posting).

## Research sources (checked on 16 Nov 2026)

Each step above was written from these official pages. Uncertain details are worded as "If you see…" in the app.

**YouTube and Google**
- [YouTube Data API: Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [Using OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
  and [refresh token expiry](https://developers.google.com/identity/protocols/oauth2) (7 days in Testing, 6 months unused)
- [Get started with the Google Auth Platform](https://support.google.com/cloud/answer/15544987),
  [Manage OAuth app branding](https://support.google.com/cloud/answer/10311615),
  [Manage app audience](https://support.google.com/cloud/answer/15549945),
  [Manage OAuth clients](https://support.google.com/cloud/answer/15549257),
  [Unverified apps](https://support.google.com/cloud/answer/7454865)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies) and
  [Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service) (privacy choice, policy
  wording, deleting data after revocation)
- [Quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
- [Three-minute YouTube Shorts](https://support.google.com/youtube/answer/15424877)

**TikTok**
- [Register your app](https://developers.tiktok.com/doc/getting-started-create-an-app)
- [Add a Sandbox](https://developers.tiktok.com/doc/add-a-sandbox)
- [Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web) and
  [token management](https://developers.tiktok.com/doc/oauth-user-access-token-management)
- [Content Posting API: Get started (Direct Post)](https://developers.tiktok.com/doc/content-posting-api-get-started),
  [Direct Post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post),
  [Query creator info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info),
  [Media transfer guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) (the Post to TikTok sheet)
- [App review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)

**Meta (Instagram and Facebook)**
- [Register as a Meta developer](https://developers.facebook.com/docs/development/register) and
  [Create an app](https://developers.facebook.com/docs/development/create-an-app)
- [App modes](https://developers.facebook.com/docs/development/build-and-test/app-modes) (Development and Live)
- [Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login),
  [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing),
  [Resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads)
- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)
- [Reels publishing for Pages](https://developers.facebook.com/docs/video-api/guides/reels-publishing)
- [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) (v27.0)

**X**
- [Getting access](https://docs.x.com/x-api/getting-started/getting-access) and
  [Developer Console](https://docs.x.com/resources/fundamentals/developer-portal)
- [Pricing and credits](https://docs.x.com/x-api/getting-started/pricing)
- [OAuth 2.0 authorization code with PKCE](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code)
- [Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked) and
  [Create a post](https://docs.x.com/x-api/posts/create-post)

### What changed on 19 Nov 2026

Checked again for Instagram, Facebook, YouTube and X (TikTok has its own check above). Ask, the in-app helper,
reads these same official pages when a step may be out of date (docs/CONTRACTS.md §28.3).

- **Instagram step 2**: new "If you see **Manage connection**" hints. On Facebook's phone app, a Page whose
  Instagram is already linked shows **Manage connection** after **Edit profile**; a Page that is not linked shows
  **Connect**. The Instagram app route (Edit profile › Page) is still right. Source: the owner's own screenshot of
  that sheet (19 Nov 2026), not a Meta help page, so the hint is worded "If it shows your Instagram name…". The same
  sheet also shows **People who help manage your Page** (Page access); the hint says to leave it as it is. When the sheet
  looks different, Ask reads Meta's own help pages (facebook.com/help) before it answers.
- **Instagram step 4** (business portfolio) is now only if Meta asks. Neither the Instagram Platform overview nor
  Content publishing requires a portfolio for a User access token on accounts you own
  ([overview](https://developers.facebook.com/documentation/instagram-platform/overview)). Content publishing also
  says a Page with a Business Manager role may need the ads permissions, so not using a portfolio is the simpler path
  ([content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)).
- **Instagram step 12**: a Page that needs Page Publishing Authorization cannot be posted to until it is done
  (same content publishing page).
- **Facebook step 1**: posting Reels needs the Page's **Content** task, not full control; full control is only needed
  to link Instagram ([Reels publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)).
- **Facebook step 7**: pages_show_list and business_management are added by default; **step 9**: leave the
  Deauthorize and Data Deletion Request boxes empty; **step 13**: Meta now says **Publish**, then **Publish** at the
  bottom right ([Create an app for Pages](https://developers.facebook.com/documentation/pages-api/create-an-app)).
  Reels from apps are 3 to 90 seconds, 9:16, at least 540x960, 30 app posts a day per Page (Reels publishing).
- **YouTube**: no step changed ([Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)).
- **X**: no step changed; the first auto-recharge is matched up to $50
  ([Pricing](https://docs.x.com/x-api/getting-started/pricing)).
