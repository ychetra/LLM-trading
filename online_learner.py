"""
Online / incremental learning for the live PPO trading agent.

How it works
────────────
The PPO model starts as a frozen, pre-trained artifact.  Every time the live
agent closes a trade the outcome is recorded.  Once MIN_TRADES_FOR_UPDATE
trades have accumulated, this class:

  1. Fetches the recent M1 bar history from MT5 (the actual bars the agent
     traded through).
  2. Resamples and computes features using the same pipeline as training.
  3. Builds a mini BracketTradingEnv from those bars.
  4. Runs a short PPO fine-tune at a REDUCED learning rate (lr × LR_SCALE)
     so the update nudges the policy toward recent market conditions without
     erasing the years of history it was trained on.
  5. Saves a timestamped checkpoint to models/online/.
  6. Hot-swaps the live model's weights so the agent uses updated policy
     immediately — no restart required.

The more trades close, the more frequently the model adapts.  Each update
is deliberately conservative: the model never overfits to a handful of
recent bars because LR_SCALE keeps individual updates small, and because
we mix the full episode distribution (randomize_start=True) inside the
mini-env rather than replaying only the exact trade bars.
"""
from __future__ import annotations

import json
import logging
from copy import deepcopy
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger("online_learner")

# ── Tuneable constants ─────────────────────────────────────────────────────────
MIN_TRADES_FOR_UPDATE = 30    # minimum closed trades before first fine-tune
TRADES_WINDOW = 100           # rolling buffer size; oldest trades fall off
ONLINE_TIMESTEPS = 5_000      # PPO steps per fine-tune (keep short)
LR_SCALE = 0.1                # multiply original LR by this to prevent forgetting
# ──────────────────────────────────────────────────────────────────────────────


class OnlineLearner:
    """Accumulates live trade outcomes and periodically fine-tunes the model."""

    def __init__(
        self,
        model,
        models_dir: str = "models",
        min_trades: int = MIN_TRADES_FOR_UPDATE,
        trades_window: int = TRADES_WINDOW,
        online_timesteps: int = ONLINE_TIMESTEPS,
        lr_scale: float = LR_SCALE,
    ) -> None:
        self.model = model
        self.models_dir = Path(models_dir)
        self.online_dir = self.models_dir / "online"
        self.online_dir.mkdir(parents=True, exist_ok=True)

        self.min_trades = min_trades
        self.trades_window = trades_window
        self.online_timesteps = online_timesteps
        self.lr_scale = lr_scale

        self._trade_buffer: list[dict] = []
        self._update_count: int = 0
        self._trades_since_last_update: int = 0

    # ── Public interface ──────────────────────────────────────────────────────

    def record_trade(self, trade: dict) -> None:
        """Called by LiveTrader after every position closes."""
        self._trade_buffer.append(trade)
        self._trades_since_last_update += 1
        n = len(self._trade_buffer)
        logger.info(
            f"[OnlineLearner] Trade recorded — buffer {n}/{self.min_trades}  "
            f"(since last update: {self._trades_since_last_update})"
        )

    def maybe_retrain(self) -> bool:
        """Trigger an online update if enough new trades have accumulated."""
        if self._trades_since_last_update < self.min_trades:
            return False
        logger.info(
            f"[OnlineLearner] {self._trades_since_last_update} new trades — "
            "starting online fine-tune."
        )
        success = self._run_update()
        if success:
            self._trades_since_last_update = 0
        return success

    def save_state(self, path: str = "logs/online_learner_state.json") -> None:
        """Persist trade buffer so the counter survives a restart."""
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(
                {
                    "update_count": self._update_count,
                    "trades_since_last_update": self._trades_since_last_update,
                    "trade_buffer": self._trade_buffer,
                },
                f,
                default=str,
            )

    def load_state(self, path: str = "logs/online_learner_state.json") -> None:
        """Restore trade buffer from a previous session."""
        p = Path(path)
        if not p.exists():
            return
        with open(p) as f:
            state = json.load(f)
        self._update_count = state.get("update_count", 0)
        self._trades_since_last_update = state.get("trades_since_last_update", 0)
        self._trade_buffer = state.get("trade_buffer", [])
        logger.info(
            f"[OnlineLearner] Restored: {len(self._trade_buffer)} trades, "
            f"{self._update_count} updates completed."
        )

    # ── Core fine-tune ────────────────────────────────────────────────────────

    def _run_update(self) -> bool:
        try:
            from stable_baselines3.common.vec_env import DummyVecEnv
            from env_bracket import BracketTradingEnv
            from config import CFG
            from features import add_stationary_features

            recent_bars = self._fetch_recent_m1_bars()
            if recent_bars is None:
                return False

            # Resample M1 → decision timeframe, compute features.
            decision = recent_bars.resample(CFG.pandas_tf).agg({
                "Open": "first", "High": "max",
                "Low": "min", "Close": "last", "Volume": "sum",
            }).dropna()

            feat, feature_cols = add_stationary_features(
                decision, atr_period=CFG.atr_period, rsi_period=CFG.rsi_period
            )
            feat = feat.iloc[CFG.warmup_bars:].dropna(subset=feature_cols)

            if len(feat) < 50:
                logger.warning("[OnlineLearner] Feature frame too short — skipping update.")
                return False

            # Slice M1 to match the feature window.
            m1_slice = recent_bars.loc[
                (recent_bars.index > feat.index.min()) &
                (recent_bars.index <= feat.index.max())
            ]

            def _make_env():
                return BracketTradingEnv(
                    decision_df=feat,
                    m1_df=m1_slice,
                    feature_cols=feature_cols,
                    sl_atr_multipliers=CFG.sl_atr_multipliers,
                    tp_r_multipliers=CFG.tp_r_multipliers,
                    initial_equity=CFG.initial_equity,
                    risk_fraction=CFG.risk_fraction,
                    spread_price=CFG.spread_price,
                    slippage_price=CFG.slippage_price,
                    commission_per_trade=CFG.commission_per_trade,
                    holding_penalty=CFG.holding_penalty,
                    reward_mtm_weight=CFG.reward_mtm_weight,
                    randomize_start=True,
                )

            env = DummyVecEnv([_make_env])

            # Deep-copy the model so a crash during fine-tuning leaves the live
            # model intact.  Only swap weights after learning succeeds.
            fine_tuned = deepcopy(self.model)

            original_lr = (
                float(fine_tuned.learning_rate)
                if not callable(fine_tuned.learning_rate)
                else fine_tuned.learning_rate(1.0)
            )
            fine_tuned.learning_rate = original_lr * self.lr_scale
            fine_tuned.set_env(env)
            fine_tuned.learn(
                total_timesteps=self.online_timesteps,
                reset_num_timesteps=False,
                progress_bar=False,
            )

            # Save checkpoint.
            self._update_count += 1
            ckpt = self.online_dir / f"checkpoint_{self._update_count:04d}"
            fine_tuned.save(str(ckpt))
            logger.info(
                f"[OnlineLearner] Update #{self._update_count} complete → {ckpt}.zip  "
                f"(trained on {len(feat)} bars)"
            )

            # Hot-swap weights into the live model (no restart needed).
            self.model.policy.load_state_dict(fine_tuned.policy.state_dict())

            # Rolling buffer: keep only the most recent window of trades.
            self._trade_buffer = self._trade_buffer[-self.trades_window:]
            return True

        except Exception:
            logger.exception("[OnlineLearner] Fine-tune failed — keeping current model.")
            return False

    def _fetch_recent_m1_bars(self) -> Optional[pd.DataFrame]:
        """Pull recent M1 bars from the live MT5 connection."""
        try:
            import MetaTrader5 as mt5
            from mt5_connector import MT5Connector
            from config import CFG

            bars_needed = min(
                CFG.warmup_bars * 60 + len(self._trade_buffer) * 60 + 500,
                50_000,
            )
            connector = MT5Connector()
            connector.connect()
            bars = connector.get_bars(mt5.TIMEFRAME_M1, count=bars_needed)
            connector.disconnect()
            return bars

        except Exception as e:
            logger.warning(
                f"[OnlineLearner] Cannot fetch live bars ({e}). "
                "MT5 connection required for online updates."
            )
            return None
