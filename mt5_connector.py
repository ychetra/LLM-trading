"""
MT5 connection layer for live trading.

MetaTrader5 Python library is Windows-only.  On Mac / Linux run MT5 inside
Wine and install mt5linux (pip install mt5linux), which monkey-patches the
MetaTrader5 module to speak over a socket to a Wine-hosted MT5 instance.

Quick Mac setup:
  1. Install Wine:     brew install --cask wine-stable
  2. Install MT5 inside Wine and log in to your Exness demo account.
  3. pip install mt5linux
  4. Inside the Wine MT5 terminal enable "Allow DLL imports" and start the
     MetaTrader5 Gateway script that mt5linux ships (run_server.py).
  5. python run_live.py --login ... --password ... --server ...
"""
from __future__ import annotations

import platform
from datetime import datetime, timezone
from typing import Optional, Tuple

import pandas as pd

try:
    import MetaTrader5 as mt5
    _MT5_AVAILABLE = True
except ImportError:
    _MT5_AVAILABLE = False


MAGIC = 20260619  # unique magic number — change if running multiple instances


class MT5ConnectorError(RuntimeError):
    pass


def _require_mt5() -> None:
    if not _MT5_AVAILABLE:
        system = platform.system()
        if system == "Darwin":
            hint = (
                "Mac detected. Install mt5linux (pip install mt5linux) and run MT5 "
                "inside Wine.  See the docstring at the top of mt5_connector.py."
            )
        elif system == "Linux":
            hint = "Install mt5linux (pip install mt5linux) and run MT5 inside Wine."
        else:
            hint = "pip install MetaTrader5"
        raise MT5ConnectorError(
            f"MetaTrader5 Python library not available.\n  {hint}"
        )


class MT5Connector:
    """Thin wrapper around the MetaTrader5 Python API for XAUUSD live trading."""

    def __init__(
        self,
        symbol: str = "XAUUSD",
        magic: int = MAGIC,
        login: Optional[int] = None,
        password: Optional[str] = None,
        server: Optional[str] = None,
        timeout: int = 60_000,
    ) -> None:
        _require_mt5()
        self.symbol = symbol
        self.magic = magic
        self._login = login
        self._password = password
        self._server = server
        self._timeout = timeout
        self._connected = False

    # ── Connection ────────────────────────────────────────────────────────────

    def connect(self) -> None:
        kwargs: dict = {"timeout": self._timeout}
        if self._login:
            kwargs["login"] = self._login
        if self._password:
            kwargs["password"] = self._password
        if self._server:
            kwargs["server"] = self._server

        if not mt5.initialize(**kwargs):
            raise MT5ConnectorError(f"MT5 initialize failed: {mt5.last_error()}")

        if not mt5.symbol_select(self.symbol, True):
            mt5.shutdown()
            raise MT5ConnectorError(
                f"Cannot select symbol {self.symbol}: {mt5.last_error()}"
            )

        self._connected = True
        info = mt5.account_info()
        print(
            f"[MT5] Connected  login={info.login}  server={info.server}  "
            f"balance={info.balance:.2f} {info.currency}  "
            f"{'DEMO' if info.trade_mode == 0 else 'LIVE'}"
        )

    def disconnect(self) -> None:
        if self._connected:
            mt5.shutdown()
            self._connected = False

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.disconnect()

    # ── Market data ───────────────────────────────────────────────────────────

    def get_bars(self, timeframe_mt5, count: int = 400) -> pd.DataFrame:
        """Fetch `count` completed bars for self.symbol.

        Returns OHLCV with bar-close UTC timestamps.  The still-forming bar
        (index 0 from MT5's perspective) is dropped so we only act on
        completed candles.
        """
        rates = mt5.copy_rates_from_pos(self.symbol, timeframe_mt5, 0, count + 1)
        if rates is None or len(rates) == 0:
            raise MT5ConnectorError(
                f"copy_rates_from_pos failed: {mt5.last_error()}"
            )

        df = pd.DataFrame(rates)
        # MT5 timestamps are bar-open UTC epoch seconds.
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        df = (
            df.set_index("time")
            .rename(columns={
                "open": "Open", "high": "High", "low": "Low",
                "close": "Close", "tick_volume": "Volume",
            })[["Open", "High", "Low", "Close", "Volume"]]
        )
        # Drop the still-forming bar (last row from MT5 = most recent).
        return df.iloc[:-1]

    def get_current_price(self) -> Tuple[float, float]:
        """Return (bid, ask) for self.symbol."""
        tick = mt5.symbol_info_tick(self.symbol)
        if tick is None:
            raise MT5ConnectorError(
                f"symbol_info_tick failed: {mt5.last_error()}"
            )
        return tick.bid, tick.ask

    def account_info(self) -> dict:
        info = mt5.account_info()
        return {
            "balance": info.balance,
            "equity": info.equity,
            "margin": info.margin,
            "free_margin": info.margin_free,
            "currency": info.currency,
        }

    # ── Position queries ──────────────────────────────────────────────────────

    def get_open_position(self) -> Optional[dict]:
        """Return the first open position for this symbol + magic, or None."""
        positions = mt5.positions_get(symbol=self.symbol)
        if not positions:
            return None
        for pos in positions:
            if pos.magic == self.magic:
                return {
                    "ticket": pos.ticket,
                    "type": pos.type,           # 0=BUY  1=SELL
                    "volume": pos.volume,
                    "price_open": pos.price_open,
                    "sl": pos.sl,
                    "tp": pos.tp,
                    "profit": pos.profit,
                    "time": datetime.fromtimestamp(pos.time, tz=timezone.utc),
                }
        return None

    # ── Order management ──────────────────────────────────────────────────────

    def place_bracket_order(
        self,
        direction: int,         # +1 long / -1 short
        sl_price: float,
        tp_price: float,
        risk_cash: float,
        comment: str = "RL_agent",
    ) -> int:
        """Send a market order with SL and TP.  Returns the position ticket."""
        sym_info = mt5.symbol_info(self.symbol)
        if sym_info is None:
            raise MT5ConnectorError(f"symbol_info failed: {mt5.last_error()}")

        bid, ask = self.get_current_price()
        price = ask if direction == 1 else bid

        # Position sizing: risk_cash / (SL_distance × pip_value_per_lot).
        tick_size = sym_info.trade_tick_size
        tick_value = sym_info.trade_tick_value
        pip_value_per_lot = tick_value / tick_size if tick_size > 0 else 1.0
        sl_distance = abs(price - sl_price)

        if sl_distance < tick_size:
            raise MT5ConnectorError("SL distance is smaller than one tick — order rejected.")

        risk_per_lot = sl_distance * pip_value_per_lot
        volume = (risk_cash / risk_per_lot) if risk_per_lot > 0 else sym_info.volume_min
        volume = max(
            sym_info.volume_min,
            min(
                sym_info.volume_max,
                round(volume / sym_info.volume_step) * sym_info.volume_step,
            ),
        )

        order_type = mt5.ORDER_TYPE_BUY if direction == 1 else mt5.ORDER_TYPE_SELL
        request = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       self.symbol,
            "volume":       volume,
            "type":         order_type,
            "price":        price,
            "sl":           round(sl_price, sym_info.digits),
            "tp":           round(tp_price, sym_info.digits),
            "deviation":    20,
            "magic":        self.magic,
            "comment":      comment,
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            code = result.retcode if result else "None"
            raise MT5ConnectorError(
                f"order_send failed retcode={code}: {mt5.last_error()}"
            )

        side = "LONG" if direction == 1 else "SHORT"
        print(
            f"[MT5] Opened {side}  vol={volume:.2f}  @ {price:.5f}  "
            f"SL={sl_price:.5f}  TP={tp_price:.5f}  ticket={result.position}"
        )
        return result.position

    def close_position(self, ticket: int) -> None:
        """Market-close an open position by ticket."""
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return
        pos = positions[0]
        bid, ask = self.get_current_price()
        close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        close_price = bid if pos.type == 0 else ask
        request = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       self.symbol,
            "volume":       pos.volume,
            "type":         close_type,
            "position":     ticket,
            "price":        close_price,
            "deviation":    20,
            "magic":        self.magic,
            "comment":      "RL_close",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            code = result.retcode if result else "None"
            raise MT5ConnectorError(
                f"close_position failed retcode={code}: {mt5.last_error()}"
            )
        print(f"[MT5] Closed ticket={ticket}")
