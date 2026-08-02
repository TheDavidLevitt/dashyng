#!/usr/bin/env bash
# dashyng one-tap bootstrap — runs inside Google Cloud Shell (browser, phone-friendly).
# Everything lands in YOUR OWN Google Cloud project: your data, your billing, your URL.
# Safe to re-run: every step is idempotent.
set -euo pipefail

echo "🏠 dashyng setup — this takes about 5 minutes."

# ---- project ----
PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT" ]; then
  PROJECT="dashyng-$(whoami | tr -cd 'a-z0-9' | cut -c1-12)-$RANDOM"
  echo "Creating project $PROJECT…"
  gcloud projects create "$PROJECT" --name="dashyng"
  gcloud config set project "$PROJECT"
fi
echo "✓ project: $PROJECT"

# ---- billing (required for Cloud Run; the free trial credits cover it) ----
BILLING=$(gcloud billing accounts list --format='value(name)' --filter=open=true | head -1)
if [ -z "$BILLING" ]; then
  echo "❌ No billing account found. Activate the free trial first (console.cloud.google.com → Activate)."
  exit 1
fi
gcloud billing projects link "$PROJECT" --billing-account="$BILLING" >/dev/null 2>&1 || true
echo "✓ billing linked (free-trial credits apply first)"

# ---- guardrail 1: budget alerts — email the moment REAL money moves ----
# Thresholds at $1 / $5 / $25 of actual spend. Trial credits offset charges, so the $1
# alert firing is your early signal that credits are exhausted.
if ! gcloud billing budgets list --billing-account="$BILLING" --format='value(displayName)' 2>/dev/null | grep -q '^dashyng-guard$'; then
  gcloud billing budgets create --billing-account="$BILLING" --display-name="dashyng-guard" \
    --budget-amount=25USD \
    --threshold-rule=percent=0.04,basis=current-spend \
    --threshold-rule=percent=0.2,basis=current-spend \
    --threshold-rule=percent=1.0,basis=current-spend 2>/dev/null \
    && echo "✓ budget alerts: email at \$1, \$5, \$25 of real spend" \
    || echo "△ budget alerts skipped (grant Billing Account Administrator or add one later in console → Billing → Budgets)"
fi

# ---- APIs ----
gcloud services enable run.googleapis.com cloudbuild.googleapis.com sheets.googleapis.com \
  drive.googleapis.com artifactregistry.googleapis.com >/dev/null
echo "✓ APIs enabled"

# ---- guardrail 2: the 90-day timer, baked into the app ----
TRIAL_END=$(date -d "+90 days" +%F 2>/dev/null || date -v+90d +%F)

# ---- deploy the dashboard ----
REGION=${REGION:-europe-west1}
echo "Deploying your dashboard to Cloud Run ($REGION)…"
gcloud run deploy dashyng --source . --region "$REGION" --quiet \
  --allow-unauthenticated --max-instances 1 --memory 512Mi \
  --set-env-vars "DASHBOARD_STORE=auto,DASHBOARD_TRIAL_END=$TRIAL_END,GCP_PROJECT=$PROJECT"
URL=$(gcloud run services describe dashyng --region "$REGION" --format='value(status.url)')

echo
echo "══════════════════════════════════════════════════"
echo "🎉 Your dashboard is live:  $URL"
echo "   Trial credits window ends: $TRIAL_END (the app warns you from 14 days out)"
echo "   Next: open the URL → ⚙ → Connect Google (creates YOUR datastore in YOUR Drive)"
echo "══════════════════════════════════════════════════"
echo
echo "Optional — your own AI helper VM ('claw', uses YOUR Claude subscription):"
echo "  bash setup/claw.sh"
