# Homebase web app

A home-care app for a shared household that runs in Safari and installs to the iPhone Home Screen.
It costs nothing to run, needs no Mac, and has no App Store step.

**What it does**
- Recurring tasks: every N days, weeks or months, counted from when it was done or on fixed dates.
  Assign to one person, anyone, or take turns.
- Skip a round ("not needed yet") with undo, or do a task early. Everything is logged with who and when.
- Laundry: basket check (skip, keep or start early), then put to wash, put to dry, folded, with shared countdowns.
- Household: members, done-this-month counts, activity feed, invite link.
- Shopping: groceries by aisle, plus a "to order for the house" list.
- Dates: festivals, guests and family events with a prep checklist.

Without sync it works on one phone straight away. Roommate sharing needs the free Supabase step below.

## 1. Put it online (free, about 5 minutes)

The app needs an `https://` address so iPhones can install it. Either option works.

**Option A, Netlify Drop (no git):** make a free Netlify account, open app.netlify.com/drop and drag this
whole folder onto the page. You get an address like `https://something.netlify.app`. Create the account first,
because sites dropped without an account may be removed after a while.

**Option B, GitHub Pages:** push this folder to a **public** GitHub repository (Pages is free for public repos),
then Settings > Pages > Deploy from branch > `main` / root. The address is `https://<you>.github.io/<repo>/`.
Putting the Supabase details in `config.js` in a public repo is fine, because those two values are meant to be public.
Your household code is never stored in the repo.

## 2. Turn on roommate sync (free Supabase project, about 10 minutes)

1. Create a free account at supabase.com and a new project. Any region near you, any database password.
2. In the project, open **SQL Editor > New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings**: copy the **Project URL** (Data API) and the **publishable** key (API Keys;
   older projects call it the "anon public" key). Never use the secret or service_role key.
4. Paste both into `config.js`, then deploy again (drag the folder again on Netlify, or push to GitHub).

Free Supabase projects can be paused after a stretch with no use (around a week, last I checked). Everyday use
keeps it awake; if it does pause, press Restore in the Supabase dashboard. Your data is kept.

## 3. Install on iPhones

1. Open the address in **Safari**, tap Share > **Add to Home Screen**, then open Homebase from the Home Screen.
2. You: create your household. Then Household tab > **Share invite link** and send it to each roommate.
3. Roommates: install the same way (step 1), open Homebase from the Home Screen, paste the invite link into
   **Got an invite from a roommate?**, tap Join, and pick or type their name.
   (Opening the link in Safari also works, but the Home Screen copy keeps its own storage, so join from there.)

## Limits you should know about

- **No alarm when the washer is done.** iPhone web apps can only notify through a push server, which this free
  setup doesn't have. The countdown is shown and shared; use "Hey Siri, set a timer for 45 minutes" alongside it.
- **Same item edited on two phones at once:** the last save wins for that item. Completions are separate records,
  so nobody's "done" is ever lost.
- **Privacy:** anyone holding your invite link can see and edit your household. Only send it to people you live with.
- Use **Household > Back up data** now and then; it downloads a JSON copy of everything.

## Files

```
index.html            page and styles
app.js                screens, actions and sync
logic.js              scheduling rules (pure functions)
config.js             your Supabase URL and key
sw.js, manifest...    offline support and Home Screen install
supabase/schema.sql   the sync table and its two functions
tests/                node --test tests/logic.test.js
```
