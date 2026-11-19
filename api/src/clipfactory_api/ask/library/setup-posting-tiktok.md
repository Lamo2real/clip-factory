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
