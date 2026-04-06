#!/bin/bash
set -e

# Agentic Control Plane — One-Command Installer for OpenClaw
#
# Usage:
#   curl -sf https://agenticcontrolplane.com/install-openclaw.sh | bash
#
# What it does:
#   1. Installs the ACP plugin into OpenClaw
#   2. Opens browser for login / signup
#   3. Provisions a workspace + API key
#   4. Stores credentials — governance hook is immediately active
#   5. Opens your audit log dashboard

API_BASE="${ACP_API_BASE:-https://api.agenticcontrolplane.com}"
DASHBOARD_BASE="${ACP_DASHBOARD_BASE:-https://cloud.agenticcontrolplane.com}"
CONFIG_DIR="$HOME/.acp"
CREDS_FILE="$CONFIG_DIR/credentials"

echo ""
echo "  Agentic Control Plane"
echo "  Identity & governance for OpenClaw"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Install OpenClaw plugin ───────────────────────────────────

echo "  Installing OpenClaw plugin..."

# Check if OpenClaw is installed
if ! command -v openclaw &> /dev/null; then
  echo "  OpenClaw not found. Please install OpenClaw first:"
  echo "  https://docs.openclaw.ai/getting-started"
  exit 1
fi

# Install the ACP governance plugin
openclaw plugins install @gatewaystack/acp-governance 2>/dev/null && echo "  Plugin installed" || {
  echo "  Installing from npm..."
  npm install -g @gatewaystack/acp-governance 2>/dev/null
  openclaw plugins install --link "$(npm root -g)/@gatewaystack/acp-governance" 2>/dev/null
  echo "  Plugin linked"
}

# ── Step 2: Authenticate ──────────────────────────────────────────────

if [ -f "$CREDS_FILE" ]; then
  echo "  Credentials already configured."
  echo ""
  read -p "  Reconfigure? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "  You're all set. View your audit logs:"
    echo "  $DASHBOARD_BASE/activity"
    echo ""
    exit 0
  fi
fi

echo "  Opening browser to log in..."
echo ""

AUTH_URL="$DASHBOARD_BASE/plugin/authorize"
if command -v open &> /dev/null; then
  open "$AUTH_URL"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$AUTH_URL"
else
  echo "  Open this URL in your browser:"
  echo "  $AUTH_URL"
  echo ""
fi

echo "  After logging in, you'll see a token."
echo ""
echo -n "  Paste your token here: "
read -r AUTH_TOKEN

if [ -z "$AUTH_TOKEN" ]; then
  echo ""
  echo "  No token provided."
  echo "  Plugin is installed — credentials can be added later at ~/.acp/credentials"
  exit 0
fi

# ── Step 3: Provision workspace ───────────────────────────────────────

echo ""
echo "  Provisioning workspace..."

PROVISION_RESPONSE=$(curl -sf -X POST "$API_BASE/plugin/provision" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" 2>&1)

if [ $? -ne 0 ]; then
  echo "  Provision failed. Plugin is installed — try again later."
  exit 1
fi

API_KEY=$(echo "$PROVISION_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
WORKSPACE=$(echo "$PROVISION_RESPONSE" | grep -o '"workspace":"[^"]*"' | cut -d'"' -f4)
IS_NEW=$(echo "$PROVISION_RESPONSE" | grep -o '"isNew":[^,}]*' | cut -d':' -f2)

if [ -z "$API_KEY" ] || [ -z "$WORKSPACE" ]; then
  echo "  Failed to parse response. Plugin is installed — try again later."
  exit 1
fi

mkdir -p "$CONFIG_DIR"
echo "$API_KEY" > "$CREDS_FILE"
chmod 600 "$CREDS_FILE"

if [ "$IS_NEW" = "true" ]; then
  echo "  Created workspace: $WORKSPACE"
else
  echo "  Connected to workspace: $WORKSPACE"
fi

# ── Step 4: Verify ────────────────────────────────────────────────────

HEALTH=$(curl -sf "$API_BASE/govern/health" 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "  Governance endpoint verified"
fi

# ── Done ──────────────────────────────────────────────────────────────

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done. Every OpenClaw tool call is now governed."
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Audit logs:  $DASHBOARD_BASE/activity"
echo "  Policies:    $DASHBOARD_BASE/policies"
echo ""
echo "  Restart OpenClaw to activate the plugin."
echo ""

# Open the dashboard
if command -v open &> /dev/null; then
  open "$DASHBOARD_BASE/activity"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$DASHBOARD_BASE/activity"
fi
