## YouTube

About 20 minutes · Free · Steps checked on 16 Nov 2026.

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
