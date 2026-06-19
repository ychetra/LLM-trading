"""
Live trading agent for XAUUSD on MT5 (Exness demo or live).

Architecture
────────────
  MT5 (Exness)
      │  M1 bars
      ▼
  live_trader.py  ──resample──▶  features.py  ──obs──▶  PPO model
                                                             │ action
      ▼                                                      │
  mt5_connector.py  ◀── (direction, SL bucket, TP bucket) ──┘
      │  bracket order
      ▼
  MT5 (position opened / closed)
      │  closed trade
      ▼
  online_learner.py  ──every N trades──▶  PPO fine-tune  ──weights──▶  live model

Observation vector (31 features)
─────────────────────────────────
  [0:25]  market features (same 25 as training — see features.py)
  [25]    position direction  (-1 / 0 / +1)
  [26]    unrealized R-multiple
  [27]    bars_in_trade / 100
  [28]    distance to TP in ATR units
  [29]    distance to SL in ATR units
  [30]    planned TP R-multiple at entry
"""
from __future__ import annotations

import json
import logging
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from config import CFG
from features import add_stationary_features
from model_artifacts import load_run_info, resolve_sb3_model_path
from online_learner import OnlineLearner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/live_trader.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("live_trader")


# Map CFG.pandas_tf → minutes per bar (used to sleep until next bar close).
_TF_MINUTES: dict[str, int] = {
    "1min": 1, "5min": 5, "15min": 15, "30min": 30,
    "1h": 60, "4h": 240, "1D": 1440,
}

# MT5 timeframe constants (resolved at runtime to avoid import errors on Mac).
def _resolve_mt5_tf(pandas_tf: str):
    import MetaTrader5 as mt5
    return {
        "1min":  mt5.TIMEFRAME_M1,
        "5min":  mt5.TIMEFRAME_M5,
        "15min": mt5.TIMEFRAME_M15,
        "30min": mt5.TIMEFRAME_M30,
        "1h":    mt5.TIMEFRAME_H1,
        "4h":    mt5.TIMEFRAME_H4,
        "1D":    mt5.TIMEFRAME_D1,
    }[pandas_tf]


class LiveTrader:
    """
    Connects to MT5, waits for each closed decision bar, runs PPO inference,
    and manages bracket orders on XAUUSD.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        symbol: str = "XAUUSD",
        login: Optional[int] = None,
        password: Optional[str] = None,
        server: Optional[str] = None,
        online_learning: bool = True,
        dry_run: bool = False,
    ) -> None:
        from stable_baselines3 import PPO
        from mt5_connector import MT5Connector

        # ── Load model ────────────────────────────────────────────────────────
        if model_path is None:
            _, run_info = load_run_info()
            model_path = run_info["model_path"]
        model_path = resolve_sb3_model_path(model_path)
        self.model = PPO.load(str(model_path))
        logger.info(f"Loaded PPO model from {model_path}")

        # ── MT5 connector ─────────────────────────────────────────────────────
        self.connector = MT5Connector(
            symbol=symbol,
            login=login,
            password=password,
            server=server,
        )
        self.symbol = symbol
        self.dry_run = dry_run

        # ── Online learning ───────────────────────────────────────────────────
        self.learner: Optional[OnlineLearner] = None
        if online_learning:
            self.learner = OnlineLearner(model=self.model)
            self.learner.load_state()

        # ── Trading state ─────────────────────────────────────────────────────
        self._open_position: Optional[dict] = None   # our tracked state
        self._feature_cols: Optional[list] = None    # discovered on first bar

        # Derived config.
        self._decision_minutes = _TF_MINUTES.get(CFG.pandas_tf, 60)
        self._sl_mults = list(CFG.sl_atr_multipliers)
        self._tp_mults = list(CFG.tp_r_multipliers)

        # Bars of M1 needed = warmup + enough decision bars for features.
        self._m1_needed = CFG.warmup_bars * self._decision_minutes + 500

        # Logs.
        Path("logs").mkdir(exist_ok=True)
        self._trade_log_path = Path("logs/live_trades.jsonl")

        # Graceful shutdown on Ctrl-C / SIGTERM.
        self._running = False
        signal.signal(signal.SIGINT,  self._handle_shutdown)
        signal.signal(signal.SIGTERM, self._handle_shutdown)

    def _handle_shutdown(self, *_):
        logger.info("Shutdown signal received — stopping after current bar.")
        self._running = False

    # ── Feature engineering ───────────────────────────────────────────────────

    def _build_obs(
        self, m1_bars: pd.DataFrame
    ) -> Optional[tuple[np.ndarray, pd.Series]]:
        """Resample → features → last-row obs vector.  Returns (obs, last_row)."""
        decision = m1_bars.resample(CFG.pandas_tf).agg({
            "Open": "first", "High": "max",
            "Low": "min", "Close": "last", "Volume": "sum",
        }).dropna()

        if len(decision) < CFG.warmup_bars + 10:
            logger.warning("Not enough bars yet for feature computation.")
            return None

        feat, feature_cols = add_stationary_features(
            decision, atr_period=CFG.atr_period, rsi_period=CFG.rsi_period
        )
        feat = feat.iloc[CFG.warmup_bars:].dropna(subset=feature_cols)
        if feat.empty:
            logger.warning("Feature frame is empty after dropping NaNs.")
            return None

        if self._feature_cols is None:
            self._feature_cols = feature_cols

        last_row = feat.iloc[-1]
        market_obs = last_row[feature_cols].values.astype(np.float32)

        # Position state (same 6 features as BracketTradingEnv._position_state_features).
        pos_obs = self._position_obs(last_row)

        obs = np.concatenate([market_obs, pos_obs])
        obs = np.nan_to_num(obs, nan=0.0, posinf=10.0, neginf=-10.0)
        return obs.astype(np.float32), last_row

    def _position_obs(self, row: pd.Series) -> np.ndarray:
        """6-element position state matching BracketTradingEnv's format."""
        if self._open_position is None:
            return np.zeros(6, dtype=np.float32)

        close = float(row["Close"])
        atr = max(float(row["atr"]), 1e-12)
        p = self._open_position
        direction = p["direction"]
        entry = p["entry_price"]
        sl = p["sl"]
        tp = p["tp"]
        risk_cash = p.get("risk_cash", 1.0)
        tp_r = p.get("tp_r", 1.0)
        bars_in_trade = p.get("bars_in_trade", 0)

        unrealized = (close - entry) * direction
        unrealized_r = unrealized / max(risk_cash, 1e-12)
        dist_tp_atr = ((tp - close) * direction) / atr
        dist_sl_atr = ((close - sl) * direction) / atr

        return np.array([
            direction,
            unrealized_r,
            min(bars_in_trade / 100.0, 10.0),
            dist_tp_atr,
            dist_sl_atr,
            tp_r,
        ], dtype=np.float32)

    # ── Action decoding ───────────────────────────────────────────────────────

    def _decode_action(
        self, action, atr: float, close: float
    ) -> tuple[int, float, float, float, float]:
        """MultiDiscrete → (direction, sl_price, tp_price, sl_dist, tp_r)."""
        dir_idx = int(action[0])
        sl_idx  = int(action[1])
        tp_idx  = int(action[2])

        direction = {0: 0, 1: 1, 2: -1}[dir_idx]

        sl_mult = self._sl_mults[min(sl_idx, len(self._sl_mults) - 1)]
        tp_r    = self._tp_mults[min(tp_idx, len(self._tp_mults) - 1)]

        sl_dist = atr * sl_mult + CFG.spread_price
        tp_dist = sl_dist * tp_r

        if direction == 1:
            sl_price = close - sl_dist
            tp_price = close + tp_dist
        elif direction == -1:
            sl_price = close + sl_dist
            tp_price = close - tp_dist
        else:
            sl_price = tp_price = 0.0

        return direction, sl_price, tp_price, sl_dist, tp_r

    # ── Trade lifecycle ───────────────────────────────────────────────────────

    def _open_trade(
        self,
        direction: int,
        sl_price: float,
        tp_price: float,
        sl_dist: float,
        tp_r: float,
        row: pd.Series,
    ) -> None:
        acct = self.connector.account_info()
        risk_cash = acct["equity"] * CFG.risk_fraction

        if self.dry_run:
            ticket = -1
            side = "LONG" if direction == 1 else "SHORT"
            logger.info(
                f"[DRY RUN] {side}  sl={sl_price:.5f}  tp={tp_price:.5f}  "
                f"risk=${risk_cash:.2f}"
            )
        else:
            ticket = self.connector.place_bracket_order(
                direction=direction,
                sl_price=sl_price,
                tp_price=tp_price,
                risk_cash=risk_cash,
            )

        self._open_position = {
            "ticket":      ticket,
            "direction":   direction,
            "entry_price": float(row["Close"]),
            "entry_time":  str(row.name),
            "sl":          sl_price,
            "tp":          tp_price,
            "sl_dist":     sl_dist,
            "tp_r":        tp_r,
            "risk_cash":   risk_cash,
            "bars_in_trade": 0,
        }

    def _close_trade(self, row: pd.Series, reason: str) -> None:
        if self._open_position is None:
            return

        if not self.dry_run:
            try:
                self.connector.close_position(self._open_position["ticket"])
            except Exception as e:
                logger.error(f"close_position error: {e}")

        entry     = self._open_position["entry_price"]
        exit_p    = float(row["Close"])
        direction = self._open_position["direction"]
        sl_dist   = self._open_position.get("sl_dist", 1.0)
        pnl_pts   = (exit_p - entry) * direction
        r_mult    = pnl_pts / max(sl_dist, 1e-12)

        record = {
            "entry_time":  self._open_position["entry_time"],
            "exit_time":   str(row.name),
            "direction":   direction,
            "entry_price": entry,
            "exit_price":  exit_p,
            "sl":          self._open_position["sl"],
            "tp":          self._open_position["tp"],
            "r_mult":      round(r_mult, 4),
            "reason":      reason,
        }
        with open(self._trade_log_path, "a") as f:
            f.write(json.dumps(record) + "\n")

        result = "WIN" if r_mult > 0 else "LOSS"
        logger.info(
            f"Trade closed [{reason}]  R={r_mult:+.2f}  {result}  "
            f"entry={entry:.5f}  exit={exit_p:.5f}"
        )
        self._open_position = None

        if self.learner:
            self.learner.record_trade(record)

    # ── Per-bar logic ─────────────────────────────────────────────────────────

    def on_new_bar(self) -> None:
        """Called once per completed decision bar."""
        import MetaTrader5 as mt5

        m1_tf = _resolve_mt5_tf(CFG.pandas_execution_tf)
        m1_bars = self.connector.get_bars(m1_tf, count=self._m1_needed)

        result = self._build_obs(m1_bars)
        if result is None:
            return
        obs, current_row = result

        # Increment bars-in-trade counter.
        if self._open_position is not None:
            self._open_position["bars_in_trade"] += 1

        # Check if MT5 auto-closed the position via SL/TP.
        if self._open_position is not None:
            live_pos = self.connector.get_open_position()
            if live_pos is None:
                # Determine whether SL or TP was hit (pessimistic: SL first).
                p = self._open_position
                if p["direction"] == 1:
                    hit_sl = float(current_row["Low"])  <= p["sl"]
                    hit_tp = float(current_row["High"]) >= p["tp"]
                else:
                    hit_sl = float(current_row["High"]) >= p["sl"]
                    hit_tp = float(current_row["Low"])  <= p["tp"]
                reason = "sl_hit" if hit_sl else ("tp_hit" if hit_tp else "auto_close")
                self._close_trade(current_row, reason)

        # Model inference.
        action, _ = self.model.predict(obs, deterministic=True)
        direction, sl_price, tp_price, sl_dist, tp_r = self._decode_action(
            action,
            atr=float(current_row["atr"]),
            close=float(current_row["Close"]),
        )

        current_dir = self._open_position["direction"] if self._open_position else 0

        # Close existing position if signal flips or goes flat.
        if current_dir != 0 and (direction == 0 or direction != current_dir):
            self._close_trade(current_row, reason="signal_flip")

        # Open new position if signal is directional and we're flat.
        if direction != 0 and self._open_position is None:
            self._open_trade(direction, sl_price, tp_price, sl_dist, tp_r, current_row)

        # Trigger online learning if threshold reached.
        if self.learner:
            self.learner.maybe_retrain()
            self.learner.save_state()

    # ── Run loop ──────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Blocking loop — wakes at each decision bar close (+5 s safety buffer)."""
        logger.info(
            f"LiveTrader starting  symbol={self.symbol}  "
            f"decision_tf={CFG.decision_timeframe}  dry_run={self.dry_run}"
        )
        self.connector.connect()
        self._running = True

        try:
            while self._running:
                try:
                    self.on_new_bar()
                except Exception:
                    logger.exception("Error in on_new_bar — will retry next bar.")

                if not self._running:
                    break

                now = datetime.now(tz=timezone.utc)
                elapsed_min = (now.minute % self._decision_minutes) + (now.second / 60.0)
                wait_sec = (self._decision_minutes - elapsed_min) * 60.0 + 5.0
                logger.info(f"Next bar in {wait_sec / 60:.1f} min — sleeping.")
                time.sleep(max(wait_sec, 10.0))

        finally:
            self.connector.disconnect()
            if self.learner:
                self.learner.save_state()
            logger.info("LiveTrader stopped.")
