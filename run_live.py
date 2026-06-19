"""
Entry point: connect to Exness MT5 demo and start live trading.

Quick start (Windows)
─────────────────────
  pip install MetaTrader5
  python run_live.py --login 12345678 --password YourPass --server Exness-MT5Trial

Quick start (Mac / Linux via Wine + mt5linux)
─────────────────────────────────────────────
  brew install --cask wine-stable
  wine path/to/mt5setup.exe      # install MT5 inside Wine, log in to Exness demo
  pip install mt5linux
  # In a separate terminal, start the mt5linux gateway inside Wine:
  #   wine python run_server.py   (script ships with mt5linux)
  python run_live.py --login 12345678 --password YourPass --server Exness-MT5Trial

Dry-run (no orders sent, just logs what would happen)
─────────────────────────────────────────────────────
  python run_live.py --dry-run

Disable online learning (frozen model)
───────────────────────────────────────
  python run_live.py --no-online-learning
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _load_dotenv(path: str = ".env") -> None:
    """Load key=value pairs from .env into os.environ (no extra dependencies)."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


def main() -> None:
    _load_dotenv()

    parser = argparse.ArgumentParser(
        description="Run the PPO XAUUSD agent live on Exness MT5."
    )
    parser.add_argument(
        "--login", type=int,
        default=int(os.environ.get("MT5_LOGIN", 0)) or None,
        help="MT5 account login number (or set MT5_LOGIN in .env).",
    )
    parser.add_argument(
        "--password", type=str,
        default=os.environ.get("MT5_PASSWORD"),
        help="MT5 account password (or set MT5_PASSWORD in .env).",
    )
    parser.add_argument(
        "--server", type=str,
        default=os.environ.get("MT5_SERVER"),
        help="MT5 server name (or set MT5_SERVER in .env).",
    )
    parser.add_argument(
        "--symbol", type=str,
        default=os.environ.get("MT5_SYMBOL", "XAUUSD"),
        help="Symbol to trade (default: XAUUSD, or set MT5_SYMBOL in .env).",
    )
    parser.add_argument(
        "--model", type=str, default=None,
        help=(
            "Path to a trained PPO .zip model.  "
            "Defaults to the path recorded in models/run_info.json."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Log signals but do not send any orders to MT5.",
    )
    parser.add_argument(
        "--no-online-learning", action="store_true",
        help="Keep model frozen — disable incremental fine-tuning.",
    )
    args = parser.parse_args()

    # Fail fast if models/run_info.json is missing and no --model given.
    if args.model is None and not Path("models/run_info.json").exists():
        print(
            "ERROR: models/run_info.json not found.\n"
            "Train the model first:\n"
            "  python train_ppo.py\n"
            "Or pass --model path/to/your_model.zip",
            file=sys.stderr,
        )
        sys.exit(1)

    from live_trader import LiveTrader

    trader = LiveTrader(
        model_path=args.model,
        symbol=args.symbol,
        login=args.login,
        password=args.password,
        server=args.server,
        online_learning=not args.no_online_learning,
        dry_run=args.dry_run,
    )
    trader.run()


if __name__ == "__main__":
    main()
