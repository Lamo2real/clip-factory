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
