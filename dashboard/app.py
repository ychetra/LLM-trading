"""
XAUUSD RL Trader — Live Dashboard
Streamlit app. Reads from logs/live_trades.jsonl and logs/online_learner_state.json.
Deploy to Railway: railway up
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
import streamlit as st

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="XAUUSD RL Trader",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ── Paths (relative to project root when launched with streamlit run) ─────────
TRADE_LOG = Path("logs/live_trades.jsonl")
LEARNER_STATE = Path("logs/online_learner_state.json")
INITIAL_EQUITY = 10_000.0

# ── Helpers ───────────────────────────────────────────────────────────────────

@st.cache_data(ttl=10)
def load_trades() -> pd.DataFrame:
    if not TRADE_LOG.exists():
        return pd.DataFrame()
    rows = []
    for line in TRADE_LOG.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["exit_time"] = pd.to_datetime(df["exit_time"], utc=True)
    df["entry_time"] = pd.to_datetime(df["entry_time"], utc=True)
    df = df.sort_values("exit_time").reset_index(drop=True)
    df["cumulative_r"] = df["r_mult"].cumsum()
    # Simulate equity curve from R-multiples (0.5% risk per trade).
    risk_per_trade = INITIAL_EQUITY * 0.005
    df["pnl"] = df["r_mult"] * risk_per_trade
    df["equity"] = INITIAL_EQUITY + df["pnl"].cumsum()
    return df


@st.cache_data(ttl=10)
def load_learner_state() -> dict:
    if not LEARNER_STATE.exists():
        return {}
    try:
        return json.loads(LEARNER_STATE.read_text())
    except Exception:
        return {}


def metric_card(label: str, value: str, delta: str = "", color: str = "normal"):
    st.metric(label=label, value=value, delta=delta if delta else None)


# ── Load data ─────────────────────────────────────────────────────────────────
df = load_trades()
state = load_learner_state()

# ── Header ────────────────────────────────────────────────────────────────────
col_title, col_refresh = st.columns([5, 1])
with col_title:
    st.title("📈 XAUUSD RL Trader Dashboard")
    st.caption(f"Auto-refreshes every 10 s — last loaded {datetime.now(timezone.utc).strftime('%H:%M:%S UTC')}")
with col_refresh:
    st.button("🔄 Refresh", on_click=load_trades.clear)

st.divider()

# ── Top KPI row ───────────────────────────────────────────────────────────────
if df.empty:
    st.info("No trades yet. Start the bot with `python run_live.py` and check back.")
    st.stop()

n_trades = len(df)
wins = (df["r_mult"] > 0).sum()
losses = (df["r_mult"] <= 0).sum()
win_rate = wins / n_trades * 100 if n_trades else 0
total_r = df["r_mult"].sum()
avg_r = df["r_mult"].mean()
gross_win = df.loc[df["r_mult"] > 0, "r_mult"].sum()
gross_loss = -df.loc[df["r_mult"] <= 0, "r_mult"].sum()
profit_factor = gross_win / gross_loss if gross_loss > 0 else float("inf")
current_equity = df["equity"].iloc[-1]
pnl_total = current_equity - INITIAL_EQUITY
max_dd = ((df["equity"].cummax() - df["equity"]) / df["equity"].cummax()).max() * 100
online_updates = state.get("update_count", 0)
buffer_size = len(state.get("trade_buffer", []))

k1, k2, k3, k4, k5, k6 = st.columns(6)
k1.metric("Equity", f"${current_equity:,.2f}", f"{pnl_total:+.2f}")
k2.metric("Total Trades", n_trades, f"{wins}W / {losses}L")
k3.metric("Win Rate", f"{win_rate:.1f}%")
k4.metric("Profit Factor", f"{profit_factor:.2f}")
k5.metric("Total R", f"{total_r:+.2f}R", f"avg {avg_r:+.2f}R")
k6.metric("AI Updates", online_updates, f"buffer {buffer_size} trades")

st.divider()

# ── Charts row ────────────────────────────────────────────────────────────────
c_left, c_right = st.columns([2, 1])

with c_left:
    st.subheader("Equity Curve")
    fig_eq = go.Figure()
    fig_eq.add_trace(go.Scatter(
        x=df["exit_time"], y=df["equity"],
        mode="lines", name="Equity",
        line=dict(color="#00d4aa", width=2),
        fill="tozeroy",
        fillcolor="rgba(0,212,170,0.08)",
    ))
    fig_eq.add_hline(y=INITIAL_EQUITY, line_dash="dash",
                     line_color="rgba(255,255,255,0.3)", annotation_text="Start")
    fig_eq.update_layout(
        height=320, margin=dict(l=0, r=0, t=10, b=0),
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=False, color="#888"),
        yaxis=dict(showgrid=True, gridcolor="rgba(255,255,255,0.05)", color="#888"),
        font=dict(color="#ccc"),
        showlegend=False,
    )
    st.plotly_chart(fig_eq, use_container_width=True)

with c_right:
    st.subheader("R Distribution")
    fig_r = px.histogram(
        df, x="r_mult", nbins=20,
        color_discrete_sequence=["#00d4aa"],
        labels={"r_mult": "R-multiple"},
    )
    fig_r.add_vline(x=0, line_color="rgba(255,100,100,0.7)", line_dash="dash")
    fig_r.update_layout(
        height=320, margin=dict(l=0, r=0, t=10, b=0),
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=False, color="#888"),
        yaxis=dict(showgrid=True, gridcolor="rgba(255,255,255,0.05)", color="#888"),
        font=dict(color="#ccc"),
        showlegend=False,
    )
    st.plotly_chart(fig_r, use_container_width=True)

# ── Drawdown chart ────────────────────────────────────────────────────────────
st.subheader("Drawdown")
dd_series = (df["equity"].cummax() - df["equity"]) / df["equity"].cummax() * 100
fig_dd = go.Figure(go.Scatter(
    x=df["exit_time"], y=-dd_series,
    fill="tozeroy", fillcolor="rgba(255,80,80,0.15)",
    line=dict(color="rgba(255,80,80,0.8)", width=1.5),
))
fig_dd.update_layout(
    height=200, margin=dict(l=0, r=0, t=5, b=0),
    paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
    xaxis=dict(showgrid=False, color="#888"),
    yaxis=dict(showgrid=True, gridcolor="rgba(255,255,255,0.05)",
               color="#888", ticksuffix="%"),
    font=dict(color="#ccc"),
    showlegend=False,
)
st.plotly_chart(fig_dd, use_container_width=True)

st.divider()

# ── AI learning status ────────────────────────────────────────────────────────
st.subheader("🤖 Online Learning Status")
la, lb, lc = st.columns(3)
la.metric("Model Fine-tunes", online_updates,
          help="Each fine-tune = 30 new closed trades triggered a PPO update")
lb.metric("Trade Buffer", buffer_size,
          help="Trades collected since last fine-tune")
lc.metric("Next Update In", f"{max(0, 30 - buffer_size)} trades",
          help="Trigger threshold: 30 new trades")

progress = min(buffer_size / 30.0, 1.0)
st.progress(progress, text=f"Buffer: {buffer_size}/30 trades to next AI update")

# ── Trade log table ───────────────────────────────────────────────────────────
st.divider()
st.subheader("Trade Log")
display_df = df[["exit_time", "direction", "entry_price", "exit_price",
                  "r_mult", "reason", "equity"]].copy()
display_df["direction"] = display_df["direction"].map({1: "🟢 LONG", -1: "🔴 SHORT"})
display_df["r_mult"] = display_df["r_mult"].apply(
    lambda x: f"+{x:.2f}R" if x > 0 else f"{x:.2f}R"
)
display_df["equity"] = display_df["equity"].apply(lambda x: f"${x:,.2f}")
display_df = display_df.rename(columns={
    "exit_time": "Closed At", "direction": "Side",
    "entry_price": "Entry", "exit_price": "Exit",
    "r_mult": "R", "reason": "Reason", "equity": "Equity",
})
st.dataframe(
    display_df.sort_values("Closed At", ascending=False).head(50),
    use_container_width=True,
    hide_index=True,
)

# ── Auto-refresh ──────────────────────────────────────────────────────────────
st.markdown("""
<script>
setTimeout(function() { window.location.reload(); }, 10000);
</script>
""", unsafe_allow_html=True)
