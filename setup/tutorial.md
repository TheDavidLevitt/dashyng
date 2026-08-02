# Get your own dashyng 🏠

Welcome! This walkthrough gives you your **own** personal dashboard — your data, your
Google account, nothing shared with anyone. It runs in this browser window; a phone is
plenty. Total time: ~5 minutes.

## Before you start (one-time, on Google's side)

If you haven't already: activate the Google Cloud **free trial** at
[console.cloud.google.com](https://console.cloud.google.com) — the button is at the top.
Google asks for a card but gives you **$300 of credits for 90 days**, and this setup adds
alarms so you'll be warned long before any real money moves.

## Step 1 — run the installer

Click the **Copy to Cloud Shell** button below, then press Enter:

```bash
bash setup/bootstrap.sh
```

The script creates your project, links the trial credits, sets **budget alarms**
(email at the first $1 / $5 / $25 of real spend), and deploys your dashboard.
At the end it prints your personal URL — bookmark it / add it to your phone's home screen.

## Step 2 — connect your data

Open your new URL → the **⚙** settings → **Connect Google**.
This creates a spreadsheet **in your own Google Drive** — that's your entire datastore.
You can open it in Google Sheets any time and see exactly what the dashboard knows.

## Step 3 (optional) — your own AI helper

If you have a Claude subscription, a tiny always-on VM can run it for the dashboard's
smart features (no per-use bills):

```bash
bash setup/claw.sh
```

## The safety rails you now have

- **Budget alarms** — email the moment the first real dollar is spent (that's also your
  "credits ran out" signal, since credits absorb charges first).
- **90-day timer** — the dashboard itself counts down and shows a banner from 14 days
  before your trial credits window ends.
- **Sponsored?** If a friend has been carrying your AI usage on their stack, your
  dashboard shows how many days of sponsorship remain — and this same installer is
  exactly how you move onto your own stack when it's time: run it, then ask your friend
  to point your dashboard's relay setting at your new URL (or just keep everything you
  already have — your data was in your own sheet all along).

## Costs after the trial

Roughly $5–15/month depending on whether you keep the VM. The budget alarms mean you'll
never find out from a bill.
