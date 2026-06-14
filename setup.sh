#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  EARTH dashboard — interactive setup
#  Run from the repo root: bash setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours & helpers ─────────────────────────────────────────────────────────
ESC=$'\033'
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
RESET="${ESC}[0m"
GREEN="${ESC}[38;5;114m"
BLUE="${ESC}[38;5;111m"
CYAN="${ESC}[38;5;80m"
YELLOW="${ESC}[38;5;221m"
RED="${ESC}[38;5;203m"
WHITE="${ESC}[97m"
GRAY="${ESC}[38;5;245m"

ok()    { printf "  ${GREEN}✓${RESET}  %s\n" "$*"; }
info()  { printf "  ${BLUE}→${RESET}  %s\n" "$*"; }
warn()  { printf "  ${YELLOW}!${RESET}  %s\n" "$*"; }
err()   { printf "  ${RED}✗${RESET}  %s\n" "$*" >&2; }
skip()  { printf "  ${GRAY}–${RESET}  ${GRAY}%s${RESET}\n" "$*"; }
label() { printf "  ${BOLD}${WHITE}%s${RESET}\n" "$*"; }
sep()   { printf "  ${GRAY}%s${RESET}\n" "─────────────────────────────────────────────"; }

section() {
  echo ""
  printf "${BOLD}${CYAN}  ┌─ %s ${GRAY}%s${RESET}\n" "$1" "${2:-}"
  printf "${BOLD}${CYAN}  └─────────────────────────────────────────${RESET}\n"
  echo ""
}

ask() {
  local var="$1" prompt="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    printf "  ${WHITE}%s${RESET} ${GRAY}[%s]${RESET}: " "$prompt" "$default"
  else
    printf "  ${WHITE}%s${RESET}: " "$prompt"
  fi
  local val
  read -r val
  val="${val:-$default}"
  printf -v "$var" '%s' "$val"
}

ask_secret() {
  local var="$1" prompt="$2"
  printf "  ${WHITE}%s${RESET} ${GRAY}(leave blank to skip)${RESET}: " "$prompt"
  local val
  read -rs val
  echo ""
  printf -v "$var" '%s' "$val"
}

yesno() {
  local prompt="$1" default="${2:-n}"
  local hint; [[ "$default" == "y" ]] && hint="Y/n" || hint="y/N"
  printf "  ${WHITE}%s${RESET} ${GRAY}[%s]${RESET}: " "$prompt" "$hint"
  local val
  read -r val
  val="${val:-$default}"
  [[ "${val,,}" == "y" || "${val,,}" == "yes" ]]
}

spinner() {
  local pid=$1 msg="$2"
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYAN}%s${RESET}  %s " "${frames[$i]}" "$msg"
    i=$(( (i+1) % ${#frames[@]} ))
    sleep 0.1
  done
  printf "\r%-60s\r" " "
  tput cnorm 2>/dev/null || true
}

geocode() {
  local city="$1"
  local encoded
  encoded="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$city" 2>/dev/null \
    || echo "${city// /+}")"
  local resp
  resp="$(curl -sf --max-time 6 \
    "https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1" \
    -H "User-Agent: earth-dashboard-setup/1.0" 2>/dev/null)" || return 1
  local lat lng
  lat="$(echo "$resp" | grep -o '"lat":"[^"]*"' | head -1 | cut -d'"' -f4)"
  lng="$(echo "$resp" | grep -o '"lon":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [[ -n "$lat" && -n "$lng" ]] && echo "${lat}|${lng}" || return 1
}

local_ip() {
  if command -v ip &>/dev/null; then
    ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1
  elif command -v ipconfig &>/dev/null; then
    ipconfig getifaddr en0 2>/dev/null || echo "localhost"
  else
    hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost"
  fi
}

compose_cmd() {
  if docker compose version &>/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose &>/dev/null; then
    echo "docker-compose"
  else
    echo ""
  fi
}

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo ""
printf "${BOLD}${WHITE}"
printf '     ███████╗ █████╗ ██████╗ ████████╗██╗  ██╗\n'
printf '     ██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██║  ██║\n'
printf '     █████╗  ███████║██████╔╝   ██║   ███████║\n'
printf '     ██╔══╝  ██╔══██║██╔══██╗   ██║   ██╔══██║\n'
printf '     ███████╗██║  ██║██║  ██║   ██║   ██║  ██║\n'
printf '     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝\n'
printf "${RESET}"
printf "     ${DIM}homelab dashboard — interactive setup${RESET}\n"
echo ""
sep

# ── Prerequisites ─────────────────────────────────────────────────────────────
section "Prerequisites"
MISSING=0

if command -v docker &>/dev/null; then
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
else
  err "Docker not found — install from https://docs.docker.com/get-docker/"
  MISSING=1
fi

DC="$(compose_cmd)"
if [[ -n "$DC" ]]; then
  ok "Docker Compose ($DC)"
else
  err "Docker Compose not found — install it alongside Docker"
  MISSING=1
fi

if command -v curl &>/dev/null; then
  ok "curl"
else
  warn "curl not found — location auto-lookup will be skipped"
fi

[[ "$MISSING" -eq 1 ]] && {
  echo ""
  err "Please fix the above, then re-run setup."
  echo ""
  exit 1
}

# ── Core config ───────────────────────────────────────────────────────────────
section "Core setup" "required"

ask DISPLAY_NAME "Your name (shown on the dashboard)" "$(whoami)"
ask PORT         "Port to run EARTH on" "8787"

echo ""
label "Location"
printf "  ${GRAY}Used for weather. Enter a city name for auto-lookup, or leave blank.${RESET}\n\n"
ask LOCATION_NAME "City name" ""

LAT="" LNG=""
if [[ -n "$LOCATION_NAME" ]]; then
  printf "  ${GRAY}Looking up coordinates...${RESET}"
  COORDS="$(geocode "$LOCATION_NAME" 2>/dev/null || echo "")"
  if [[ -n "$COORDS" ]]; then
    LAT="${COORDS%%|*}"; LAT="${LAT:0:8}"
    LNG="${COORDS##*|}"; LNG="${LNG:0:8}"
    printf "\r  ${GREEN}✓${RESET}  Coordinates: ${WHITE}%s, %s${RESET}                    \n" "$LAT" "$LNG"
  else
    printf "\r  ${YELLOW}!${RESET}  Auto-lookup failed — enter manually or leave blank\n"
    ask LAT "Latitude  (e.g. 51.505)" ""
    ask LNG  "Longitude (e.g. -0.127)" ""
  fi
fi

echo ""
printf "  ${GRAY}Available themes: dark | light | nord | catppuccin | gruvbox${RESET}\n"
printf "  ${GRAY}                  dracula | tokyo | rosepine | solarized | monokai${RESET}\n"
ask THEME "Theme" "dark"

# ── AI keys ───────────────────────────────────────────────────────────────────
section "AI features" "optional — weather narrative & LLM widget"
printf "  ${GRAY}One key is enough. Mistral has a generous free tier.${RESET}\n\n"

ask_secret MISTRAL_KEY   "Mistral API key   (console.mistral.ai)"
ask_secret OPENAI_KEY    "OpenAI API key    (platform.openai.com)"
ask_secret ANTHROPIC_KEY "Anthropic API key (console.anthropic.com)"
ask_secret GEMINI_KEY    "Gemini API key    (aistudio.google.com)"

# ── Media ─────────────────────────────────────────────────────────────────────
JELLYFIN_URL="" JELLYFIN_KEY=""
RADARR_URL=""   RADARR_KEY=""
SONARR_URL=""   SONARR_KEY=""
IMMICH_URL=""   IMMICH_KEY=""
QBITTORRENT_URL="" QBITTORRENT_USER="" QBITTORRENT_PASS=""

section "Media services" "optional"
if yesno "Configure Jellyfin?"; then
  ask       JELLYFIN_URL "Jellyfin URL" "http://jellyfin.local:8096"
  ask_secret JELLYFIN_KEY "Jellyfin API key"
fi
echo ""
if yesno "Configure Radarr?"; then
  ask       RADARR_URL "Radarr URL" "http://radarr.local:7878"
  ask_secret RADARR_KEY "Radarr API key"
fi
echo ""
if yesno "Configure Sonarr?"; then
  ask       SONARR_URL "Sonarr URL" "http://sonarr.local:8989"
  ask_secret SONARR_KEY "Sonarr API key"
fi
echo ""
if yesno "Configure Immich?"; then
  ask       IMMICH_URL "Immich URL" "http://immich.local:2283"
  ask_secret IMMICH_KEY "Immich API key"
fi
echo ""
if yesno "Configure qBittorrent?"; then
  ask       QBITTORRENT_URL  "qBittorrent URL"      "http://qbittorrent.local:8080"
  ask       QBITTORRENT_USER "qBittorrent username" "admin"
  ask_secret QBITTORRENT_PASS "qBittorrent password"
fi

# ── Network & monitoring ──────────────────────────────────────────────────────
ADGUARD_URL="" ADGUARD_USER="" ADGUARD_PASS=""
GLANCES_URL="" GLANCES_USER="" GLANCES_PASS=""

section "Network & monitoring" "optional"
if yesno "Configure AdGuard Home?"; then
  ask       ADGUARD_URL  "AdGuard URL"      "http://adguard.local:3000"
  ask       ADGUARD_USER "AdGuard username" "admin"
  ask_secret ADGUARD_PASS "AdGuard password"
fi
echo ""
if yesno "Configure Glances (system stats)?"; then
  ask       GLANCES_URL  "Glances URL"      "http://localhost:61208"
  ask       GLANCES_USER "Glances username (blank if none)" ""
  ask_secret GLANCES_PASS "Glances password"
fi

# ── Entertainment ─────────────────────────────────────────────────────────────
TMDB_TOKEN="" LASTFM_KEY="" LASTFM_USER="" GITHUB_TOKEN="" GITHUB_USER=""

section "Entertainment & integrations" "optional — enable Advanced in Settings to configure"
ask_secret TMDB_TOKEN "TMDB token (themoviedb.org — for Discover)"
echo ""
if yesno "Configure Last.fm?"; then
  ask_secret LASTFM_KEY  "Last.fm API key (last.fm/api)"
  ask       LASTFM_USER "Last.fm username" ""
fi
echo ""
if yesno "Configure GitHub?"; then
  ask_secret GITHUB_TOKEN "GitHub token (github.com → Settings → Tokens)"
  ask       GITHUB_USER  "GitHub username" ""
fi

# ── Write .env ────────────────────────────────────────────────────────────────
section "Writing config files"

cat > ".env" << ENV
# EARTH dashboard — generated by setup.sh on $(date)
PORT=${PORT}

MISTRAL_KEY=${MISTRAL_KEY}
OPENAI_KEY=${OPENAI_KEY}
ANTHROPIC_KEY=${ANTHROPIC_KEY}
GEMINI_KEY=${GEMINI_KEY}

JELLYFIN_URL=${JELLYFIN_URL}
JELLYFIN_KEY=${JELLYFIN_KEY}

RADARR_URL=${RADARR_URL}
RADARR_KEY=${RADARR_KEY}

SONARR_URL=${SONARR_URL}
SONARR_KEY=${SONARR_KEY}

IMMICH_URL=${IMMICH_URL}
IMMICH_KEY=${IMMICH_KEY}

QBITTORRENT_URL=${QBITTORRENT_URL}
QBITTORRENT_USER=${QBITTORRENT_USER}
QBITTORRENT_PASS=${QBITTORRENT_PASS}

ADGUARD_URL=${ADGUARD_URL}
ADGUARD_USER=${ADGUARD_USER}
ADGUARD_PASS=${ADGUARD_PASS}

GLANCES_URL=${GLANCES_URL}
GLANCES_USER=${GLANCES_USER}
GLANCES_PASS=${GLANCES_PASS}

TMDB_TOKEN=${TMDB_TOKEN}

LASTFM_KEY=${LASTFM_KEY}
LASTFM_USER=${LASTFM_USER}

GITHUB_TOKEN=${GITHUB_TOKEN}
GITHUB_USER=${GITHUB_USER}
ENV

ok ".env written"

if [[ -f "earth.yaml" ]]; then
  warn "earth.yaml already exists — leaving it unchanged"
else
  if [[ -f "earth.yaml.example" ]]; then
    # Escape for sed
    SAFE_NAME="${DISPLAY_NAME//\//\\/}"
    SAFE_THEME="${THEME//\//\\/}"
    sed \
      -e "s/^name: .*/name: ${SAFE_NAME}/" \
      -e "s/^theme: .*/theme: ${SAFE_THEME}/" \
      earth.yaml.example > earth.yaml
    if [[ -n "$LAT" && -n "$LNG" ]]; then
      SAFE_LOC="${LOCATION_NAME//\//\\/}"
      sed -i.bak \
        "s|^location: .*|location: { name: ${SAFE_LOC}, lat: ${LAT}, lng: ${LNG} }|" \
        earth.yaml && rm -f earth.yaml.bak
    fi
    ok "earth.yaml created"
  else
    warn "earth.yaml.example not found — create earth.yaml manually before starting"
  fi
fi

# ── Pull & start ──────────────────────────────────────────────────────────────
section "Starting EARTH"

info "Pulling latest image..."
( $DC pull -q 2>&1 ) &
PULL_PID=$!
spinner $PULL_PID "Pulling from ghcr.io"
wait $PULL_PID && ok "Image ready" || { err "Pull failed — check your internet connection"; exit 1; }

echo ""
( $DC up -d 2>&1 ) &
UP_PID=$!
spinner $UP_PID "Starting container"
wait $UP_PID && ok "Container started" || { err "docker compose up failed — run: $DC logs"; exit 1; }

echo ""
info "Waiting for dashboard to respond..."
ATTEMPTS=0
until curl -sf "http://localhost:${PORT}" > /dev/null 2>&1 || [[ $ATTEMPTS -ge 30 ]]; do
  sleep 1; ATTEMPTS=$((ATTEMPTS + 1))
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
sep
echo ""
IP="$(local_ip)"

if [[ $ATTEMPTS -ge 30 ]]; then
  warn "Dashboard didn't respond within 30 seconds — it may still be warming up."
  info "Check logs with: ${BOLD}$DC logs -f${RESET}"
else
  printf "  ${GREEN}${BOLD}✓  EARTH is live!${RESET}\n\n"
fi

printf "  ${BOLD}${WHITE}Local network:${RESET}  ${CYAN}http://${IP}:${PORT}${RESET}\n"
printf "  ${BOLD}${WHITE}This machine:${RESET}   ${CYAN}http://localhost:${PORT}${RESET}\n"
echo ""
printf "  ${GRAY}Secrets live in ${BOLD}.env${RESET}${GRAY} — edit and run ${BOLD}$DC restart${RESET}${GRAY} to apply.${RESET}\n"
printf "  ${GRAY}Your config is ${BOLD}earth.yaml${RESET}${GRAY} — changes push to the browser instantly.${RESET}\n"
printf "  ${GRAY}Logs:  ${BOLD}$DC logs -f${RESET}\n"
printf "  ${GRAY}Stop:  ${BOLD}$DC down${RESET}\n"
echo ""
sep
echo ""
