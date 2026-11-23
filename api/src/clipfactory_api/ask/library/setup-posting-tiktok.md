## TikTok

About 40 minutes, plus the time TikTok takes to check your app · Free · Steps checked on 21 Nov 2026.

**Please read first.** Until TikTok checks and approves the app, it can only post to a **private** account, and every
post is **"Only me"**. TikTok often says no to apps that only one person uses. If it says no, Clip Factory still posts
to TikTok, but only you can see those posts, and TikTok gives no numbers for them.

**Want everyone to see it now? Your Mac posts it** (docs/CONTRACTS.md §47). Turn on **Settings › Posting › Your Mac
posts TikTok** and set up the helper on your Mac ([mac/tiktok-helper](../mac/tiktok-helper/README.md)). Then **Upload**
and auto-posting give TikTok to your Mac, and it posts each clip for **Everyone**, out of sight. Each clip's TikTok row
in Library says what your Mac is doing: **Waiting for your Mac**, **Posting…**, then **Posted by your Mac · Everyone**
with **Open**. **Didn't work**? Tap **Try again**. Your Mac couldn't tell if it posted? Look on your TikTok: it's there?
Tap **It's on TikTok**; it isn't? Tap **Try again**. **Not on TikTok yet**? Tap **Post with my Mac**. The row says your
Mac is off or hasn't checked in? Tap **Turn on**. Your Mac needs you, or it is paused? Tap **Open Your Mac posts
TikTok**. **Everyone** needs a public TikTok account. While your
account is public, TikTok will not let Clip Factory upload there for you (its rule for apps it has not approved), so
your Mac does it. Keep your account public. There is no "Post it yourself" any more (it went on 22 Nov 2026,
[ADR-85](DECISIONS.md#adr-85-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app)). A
clip you posted in TikTok yourself earlier keeps **Posted by you · Everyone**; with no link yet, type or paste it in the
row and tap **Save the link** (an empty box makes Clip Factory look for it on your TikTok).

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
- Description: copy it. TikTok gets its own one: it names the other creators' videos and paid campaigns too.
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
  video.publish: post clips I approved with Upload straight to my own TikTok (Direct Post).
  video.upload: comes with Content Posting API. Clip Factory does not ask for it; it only uses Direct Post.
  video.list: show the views and likes of my own posts on my Clip Factory dashboard.
  user.info.stats: show my follower count on my Clip Factory Money page, only after I say OK."
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
- Press **Continue**. You come back with confetti. This step ticks itself.
- Status: "Works now, but your TikTok posts stay private until TikTok says yes."

### Part 4: Go public

#### 21. Record the real demo video
- Use a computer. Connect in the Sandbox, your TikTok still private, **Your Mac posts TikTok** off. Record your screen
  with the address bar in sight.
- Follow the shot list below, in order. It starts on the About page, then **Connect TikTok** and TikTok's
  screen with **Continue**.
- Then **Upload** one clip, choosing everything by hand in the **TikTok** row. Show each line TikTok wants to see.
- End with the post arriving on your TikTok. Keep it short, about 1 minute. Save it as MP4, under 50 MB. You can send
  up to 5 videos.
- The same video goes to App review (step 22) and to the form (step 24).
- A line from the shot list you can't find? Tap the **TikTok** row to open it. Every line is in there or right above
  **Upload**. TikTok checks every one.
- Your Client secret, a key or a long code on screen? Cut that part out before you upload the video.

The shot list (Clip Factory has a **Copy** button for it):

> 1. Start on the About page. Show the Privacy and Terms links, and keep the address bar in sight.
> 2. Sign in. Open Settings › Posting › Set up posting › TikTok. Press Connect TikTok. Show TikTok's screen with every permission, press Continue, then show TikTok connected.
> 3. Show where the clip comes from: the long video or stream you picked (or the campaign brief).
> 4. Open Review. Play the clip. Show it has no watermark or logo on it.
> 5. Show nothing is set for TikTok yet. Tap the TikTok row (caption and settings). Show "Asking TikTok…", then "Posting as" with your name and picture.
> 6. Change the TikTok caption: the words and the hashtags.
> 7. Show Upload is held: "Pick who can see it on TikTok first." Open Who can see it: nothing is picked, and only TikTok's choices are there. Don't pick yet.
> 8. Show Comments, Duet and Stitch: all off. Turn one on by hand. A switch you turned off in TikTok is grey: "Turned off in your TikTok settings."
> 9. Turn on Commercial content. Show the line under it: "Pick Your brand, Branded content, or both." Pick Only me in Who can see it. Show Upload is still held: "Pick Your brand or Branded content on TikTok first."
> 10. Tick Your brand. Show its "Promotional content" tag.
> 11. Tick Branded content. Show "Paid partnership" and the Branded Content Policy line above Upload. Who can see it now says: "Branded content can't be Only me. Turn off Branded content."
> 12. Untick Branded content. Pick Only me by hand. Turn Commercial content off.
> 13. Show the Music Usage Confirmation line right above Upload.
> 14. Press Upload. Show the note: "TikTok can take a few minutes to process your clip."
> 15. Open Library. Show the clip on its way, then Posted.
> 16. Open TikTok. Show the post: private (only you can see it), your caption as you changed it, your Comments, Duet and Stitch picks, and no watermark.
> 17. Open Money. Show the TikTok part (it uses video.list and user.info.stats). If it asks for your OK, give it, so TikTok's screen shows user.info.stats.
> 18. Last, on another clip: show nothing is on. Tap Use my settings: your saved TikTok choices go on with that one tap. Tap the TikTok row to show every option.

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
- Only after **App review** says **Live** (step 22). In **Production**, open **Content Posting API**. Press **Apply**
  next to **Direct Post**. (Or press **Open TikTok's form**: developers.tiktok.com/application/content-posting-api.)
- The form has 4 pages and does not save. Paste each answer below into the box with the same name. Clip Factory has a
  **Copy** button for each.
- Page 1, **General Information**: your full name (type your own), the organization name, website and description.
- Page 2, **API client information**: the app ID (the long number after /app/ in the address bar of your TikTok app
  page), how you use Direct Post, and how many users. Pick the smallest choice, then paste how you got the number.
- Page 3, **Supporting documents**: upload your demo video from step 21. Paste the data you store.
- Page 4, **Review**: read the 3 boxes and tick them. Press **Next**. A spinner means your video is uploading: it can
  take 2 minutes. Keep the page open.
- Then it says **Under review**. TikTok often takes 1 to 3 weeks.
- **TikTok may say no, because Clip Factory is a tool for one creator.** TikTok's rules ask for apps that many people
  can use. Clip Factory is only for you. If it says no, your posts stay private, but they still post.
- A no with empty **Review comments**? Ask TikTok support (developers.tiktok.com/support) for the reason before you
  try again.

The answers, word for word. They are all true today: do not change them to sound bigger.

- **Organization name**: Clip Factory
- **Organization website**: your About page (the Website URL from step 8)
- **Organization description**:

> Clip Factory is my own clipping tool, for me as one creator. Today I am its only user. Sign-up is invite-only, so it is not open to the public.
>
> There is no company. Clip Factory is the name of my tool, and I am one person.
>
> It turns long videos and streams I pick into short vertical clips. The sources are my own gameplay recordings and other creators' streams and videos, including paid clipping campaigns (such as Content Rewards), where a creator pays clippers to post clips of their content. I treat campaign clips as paid partnerships and mark them as Branded content.
>
> I watch every clip and post only the ones I approve, to my own TikTok account, which I connected myself with Login Kit.

- **How you use Direct Post**:

> Clip Factory uses Direct Post to post one clip to my own TikTok account when I press Upload. Nothing posts by itself.
>
> Before each post it asks TikTok for my creator info and shows my nickname and picture. I pick who can see it from TikTok's own options; nothing is picked for me. Comments, Duet and Stitch start off, and a setting I turned off in TikTok stays off and grey. I can turn on Commercial content and pick Your brand, Branded content or both; Branded content can't be Only me. I can edit the caption. TikTok's Music Usage Confirmation (and the Branded Content Policy for branded content) shows above Upload. A clip longer than TikTok allows for me can't be posted.
>
> After Upload, Clip Factory sends the video file, tells me TikTok can take a few minutes, and checks the post status until it is posted.
>
> A Use my settings button puts my saved TikTok choices on with one tap of mine, per clip. Opening the TikTok row shows every option.
>
> Other scopes: user.info.basic shows my name and picture. video.list shows the views and likes of my own posts. user.info.stats shows my follower count on my Money page, only after I say OK.

- **How you got the number**:

> Clip Factory has one user: me. Sign-up is invite-only, so at most 1 creator posts with it on any day, up to about 15 clips, which is TikTok's own daily limit for one creator. So I picked the smallest choice.

- **Data you store**:

> Clip Factory stores this TikTok data, for my one account only:
> - open_id
> - access token and refresh token (in AWS Secrets Manager, encrypted at rest), and when they expire
> - the scopes I granted
> - username, display name and avatar URL
> - for each post: publish_id, the privacy level I picked, the post status, TikTok's post id, and the error if a post fails
> - the caption I wrote
> - views, likes, comments and shares of my own posts (video.list)
> - a total of views and a count of long videos from my recent videos (video.list)
> - my follower count (user.info.stats, only after I say OK)
> Disconnect revokes the token and deletes it.

#### 25. Make your account public again
- Only after the form in step 24 passes: turn **Private account** off again.
- Posts from before stay private. To show one, change it to **Everyone** in the TikTok app.
- TikTok still allows about 15 posts a day.

### If TikTok says something went wrong

| You see | Do this |
|---|---|
| "You pressed cancel. Press Connect TikTok to try again." | Press **Connect TikTok**. |
| "That took too long. Press Connect TikTok again." | Press **Connect TikTok** again. |
| "The key does not work. Copy the Client key and secret again (step 15)." | Do step 15 again (in the Sandbox: step 19). |
| "The return address does not match. Copy it again in step 10." | Do step 10 again with the **Copy** button. |
| "A permission box was not ticked. Connect again and tick every box." | Do step 12, then connect again and leave every switch on. |
| "TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone." | Tap **Post with my Mac** on the clip's TikTok row (it says **Turn on** first while **Your Mac posts TikTok** is off). Keep your account public. |
| "TikTok did not answer. Try again in a few minutes." | Wait, then press **Connect TikTok**. |
| "Finish the TikTok review steps to post outside the Sandbox." | Do steps 21 to 23. |

**While your Mac posts TikTok**, a clip with TikTok ticked starts on your saved choices like every other place
(Everyone, with Comments, Duet and Stitch on, unless you changed them): just press **Upload**. Open the **TikTok** row
to change it for that clip; **Use my settings** puts yours back. **While Your Mac posts TikTok is off**, every clip with
TikTok ticked waits for your tap: press **Use my settings** (it puts your saved TikTok choices on), or open the
**TikTok** row and pick who can see it there (there is no default, TikTok's rule for apps that post through its API).
The row also has the Comments, Duet and Stitch switches and Commercial content (tick **Branded content** for a paid
partnership). Then press **Upload**. TikTok can take a few minutes to process your clip. Your saved choices live in
Settings › Posting › My settings.

If a clip says "Pick who can see it on TikTok again, then press Try again.", press **Try again** on the clip. The
**Post to TikTok** sheet opens first. Pick again, then press the vermilion-red button on the sheet.

---
