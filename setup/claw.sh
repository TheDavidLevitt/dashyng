#!/usr/bin/env bash
# Optional claw VM: a tiny always-on machine that runs Claude headlessly on YOUR
# subscription (no API bills) for the dashboard's agent features.
set -euo pipefail
ZONE=${ZONE:-europe-west1-b}
if ! gcloud compute instances describe claw --zone "$ZONE" >/dev/null 2>&1; then
  gcloud services enable compute.googleapis.com >/dev/null
  gcloud compute instances create claw --zone "$ZONE" --machine-type=e2-small \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB
  echo "✓ VM created (e2-small ≈ \$13/mo, covered by trial credits while they last)"
fi
echo "Connecting you to the VM — then run:"
echo "  curl -fsSL https://claude.ai/install.sh | bash && claude setup-token"
echo "(setup-token prints a link — open it, sign in with your Claude account, done.)"
gcloud compute ssh claw --zone "$ZONE"
