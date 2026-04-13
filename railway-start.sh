#!/bin/bash
# NanoClaw Railway startup script
# Starts the Docker daemon, loads/builds the agent image, then starts NanoClaw.
set -e

DATA_VOLUME="${DATA_VOLUME:-/app}"
AGENT_TAR="$DATA_VOLUME/nanoclaw-agent.tar"

# ── 1. Configure for host-network mode ────────────────────────────────────────
# Railway containers don't have CAP_NET_ADMIN for iptables, so we run dockerd
# with --iptables=false and tell NanoClaw to launch agents with --network=host.
# Host-network containers share the Railway host's network stack directly —
# no NAT tables needed and the credential proxy is reachable at localhost.
export CONTAINER_NETWORK_MODE=host

# ── 2. Start Docker daemon ────────────────────────────────────────────────────
echo "[nanoclaw] Starting Docker daemon (--iptables=false)..."
dockerd --host=unix:///var/run/docker.sock --iptables=false 2>&1 | sed 's/^/[dockerd] /' &

# Wait up to 60 seconds for dockerd to become responsive
for i in $(seq 1 60); do
  sleep 1
  if docker info >/dev/null 2>&1; then
    echo "[nanoclaw] Docker daemon ready (${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[nanoclaw] ERROR: Docker daemon did not start in 60s" >&2
    exit 1
  fi
done

# ── 3. Load or build the agent container image ────────────────────────────────
if docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  echo "[nanoclaw] Agent image already present in Docker"

elif [ -f "$AGENT_TAR" ]; then
  echo "[nanoclaw] Loading cached agent image from $AGENT_TAR ..."
  docker load < "$AGENT_TAR"
  echo "[nanoclaw] Agent image loaded"

else
  echo "[nanoclaw] Building agent image (first run — this takes several minutes)..."
  docker build -t nanoclaw-agent:latest /app/container/
  echo "[nanoclaw] Saving agent image to cache ($AGENT_TAR) ..."
  mkdir -p "$DATA_VOLUME"
  docker save nanoclaw-agent:latest > "$AGENT_TAR"
  echo "[nanoclaw] Agent image cached"
fi

# ── 4. Start NanoClaw ─────────────────────────────────────────────────────────
echo "[nanoclaw] Starting NanoClaw..."
exec node /app/dist/index.js
