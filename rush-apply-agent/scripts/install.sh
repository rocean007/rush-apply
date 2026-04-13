
set -e

REPO="https://github.com/rocean007/rush-apply/blob/main/rush-apply-agent"
DIR="rush-apply-agent"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     RushApply AI Agent Installer     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Check Python ─────────────────────────
if ! command -v python3 &>/dev/null; then
    echo "❌  Python 3.11+ required. Install from https://python.org"
    exit 1
fi

PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "✓ Python $PYTHON_VER detected"

# ── Clone or download ────────────────────
if command -v git &>/dev/null; then
    echo "→  Cloning from $REPO ..."
    git clone --depth 1 "$REPO" "$DIR" 2>/dev/null || {
        echo "  Git clone failed. Trying direct download..."
        curl -fsSL "$REPO/archive/main.tar.gz" | tar xz
        mv rush-apply-agent-main "$DIR"
    }
else
    echo "→  Downloading archive..."
    curl -fsSL "$REPO/archive/main.tar.gz" | tar xz
    mv rush-apply-agent-main "$DIR"
fi

cd "$DIR"

# ── Install deps ─────────────────────────
echo "→  Installing Python dependencies..."
pip install -r requirements.txt --quiet

# ── Install Playwright Chromium ──────────
echo "→  Installing Playwright Chromium..."
playwright install chromium --with-deps 2>/dev/null || playwright install chromium

# ── Copy .env ─────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "⚠️   Created .env from .env.example"
    echo "     Edit it with your credentials before running."
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║          Installation Complete       ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. cd $DIR"
echo "  2. Edit .env with your credentials"
echo "  3. python main.py --email you@example.com --password yourpassword"
echo ""
