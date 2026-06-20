'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface RawTrade {
  entry_time: string;
  exit_time: string;
  direction: number;
  entry_price: number;
  exit_price: number;
  r_mult: number;
  reason: string;
}

interface Trade extends RawTrade {
  equity: number;
  pnl: number;
  cumulative_r: number;
  drawdown_pct: number;
}

interface State {
  update_count: number;
  trade_buffer: RawTrade[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const INITIAL_EQUITY = 10_000;
const RISK_PER_TRADE = INITIAL_EQUITY * 0.005;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function processTrades(raw: RawTrade[]): Trade[] {
  const sorted = [...raw].sort(
    (a, b) => new Date(a.exit_time).getTime() - new Date(b.exit_time).getTime()
  );
  let equity = INITIAL_EQUITY;
  let cumR = 0;
  let peak = INITIAL_EQUITY;
  return sorted.map((t) => {
    const pnl = t.r_mult * RISK_PER_TRADE;
    equity += pnl;
    cumR += t.r_mult;
    if (equity > peak) peak = equity;
    const drawdown_pct = -((peak - equity) / peak) * 100;
    return { ...t, equity, pnl, cumulative_r: cumR, drawdown_pct };
  });
}

function buildHistogram(values: number[], bins = 14) {
  if (!values.length) return [];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const size = (max - min) / bins;
  return Array.from({ length: bins }, (_, i) => {
    const lo = min + i * size;
    const hi = lo + size;
    const mid = (lo + hi) / 2;
    const count = values.filter((v) =>
      i === bins - 1 ? v >= lo && v <= hi : v >= lo && v < hi
    ).length;
    return { bin: mid.toFixed(2), count, positive: mid >= 0 };
  });
}

function fmt$$(n: number) {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

// ─── Custom tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, fmt }: {
  active?: boolean;
  payload?: { value: number; color?: string }[];
  label?: string;
  fmt?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0e1420] border border-white/10 rounded-lg px-3 py-2 text-xs shadow-2xl backdrop-blur">
      <p className="text-slate-400 mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color ?? '#22d3ee' }} className="font-mono font-semibold">
          {fmt ? fmt(p.value) : p.value}
        </p>
      ))}
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  sub,
  color = 'text-slate-100',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-[#0d1220]/80 backdrop-blur border border-white/[0.07] rounded-2xl p-4 hover:border-white/[0.12] transition-all">
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">
        {label}
      </p>
      <p className={`text-xl font-bold leading-tight ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center fade-in">
      <div className="text-5xl mb-4">📊</div>
      <h2 className="text-xl font-semibold text-slate-300 mb-2">No trades yet</h2>
      <p className="text-slate-500 text-sm max-w-sm mb-6">
        Start the trading bot locally and it will push trades here in real-time.
      </p>
      <code className="bg-white/5 border border-white/10 text-cyan-400 text-sm px-4 py-2 rounded-lg font-mono">
        python run_live.py
      </code>
    </div>
  );
}

// ─── Skeleton loader ───────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`bg-white/5 rounded-xl animate-pulse ${className ?? ''}`} />
  );
}

// ─── Main dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [botState, setBotState] = useState<State>({ update_count: 0, trade_buffer: [] });
  const [lastUpdated, setLastUpdated] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/trades', { cache: 'no-store' }),
        fetch('/api/state', { cache: 'no-store' }),
      ]);
      const [rawTrades, stateData] = await Promise.all([tRes.json(), sRes.json()]);
      setTrades(processTrades(rawTrades));
      setBotState(stateData);
      setLastUpdated(
        new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC'
      );
    } catch {
      // network error — keep showing stale data
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ─── Derived stats ──────────────────────────────────────────────────────────
  const n = trades.length;
  const wins = trades.filter((t) => t.r_mult > 0).length;
  const losses = trades.filter((t) => t.r_mult <= 0).length;
  const winRate = n ? (wins / n) * 100 : 0;
  const totalR = trades.reduce((s, t) => s + t.r_mult, 0);
  const avgR = n ? totalR / n : 0;
  const grossWin = trades.filter((t) => t.r_mult > 0).reduce((s, t) => s + t.r_mult, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.r_mult <= 0).reduce((s, t) => s + t.r_mult, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const currentEquity = trades.at(-1)?.equity ?? INITIAL_EQUITY;
  const pnlTotal = currentEquity - INITIAL_EQUITY;
  const maxDd = n ? Math.min(...trades.map((t) => t.drawdown_pct)) : 0;

  const bufferSize = botState.trade_buffer?.length ?? 0;
  const bufferPct = Math.min(bufferSize / 30, 1) * 100;

  // Chart data
  const equityData = trades.map((t) => ({
    t: fmtTime(t.exit_time),
    v: +t.equity.toFixed(2),
  }));

  const ddData = trades.map((t) => ({
    t: fmtTime(t.exit_time),
    v: +t.drawdown_pct.toFixed(3),
  }));

  const histData = buildHistogram(trades.map((t) => t.r_mult));

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen px-4 py-6 md:px-8 md:py-8 max-w-[1440px] mx-auto">

      {/* ── Header ── */}
      <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="text-2xl">📈</span>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-50">
              XAUUSD RL Trader
            </h1>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
              LIVE
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Auto-refreshes every 5 s{lastUpdated ? ` · ${lastUpdated}` : ''}
          </p>
        </div>

        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-200
            bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] px-4 py-2.5 rounded-xl
            transition-all disabled:opacity-50"
        >
          <span className={refreshing ? 'animate-spin inline-block' : ''}>↻</span>
          Refresh
        </button>
      </header>

      {/* ── Loading skeletons ── */}
      {loading && (
        <div className="space-y-4 fade-in">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Skeleton className="lg:col-span-2 h-72" />
            <Skeleton className="h-72" />
          </div>
          <Skeleton className="h-44" />
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && n === 0 && <EmptyState />}

      {/* ── Dashboard ── */}
      {!loading && n > 0 && (
        <div className="space-y-4 fade-in">

          {/* KPI Row */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KPICard
              label="Equity"
              value={fmt$$(currentEquity)}
              sub={`${pnlTotal >= 0 ? '+' : ''}${fmt$$(pnlTotal)} PnL`}
              color={pnlTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}
            />
            <KPICard
              label="Total Trades"
              value={String(n)}
              sub={`${wins} W  /  ${losses} L`}
            />
            <KPICard
              label="Win Rate"
              value={`${winRate.toFixed(1)}%`}
              color={winRate >= 55 ? 'text-emerald-400' : winRate >= 45 ? 'text-amber-400' : 'text-red-400'}
            />
            <KPICard
              label="Profit Factor"
              value={isFinite(pf) ? pf.toFixed(2) : '∞'}
              color={pf >= 1.5 ? 'text-emerald-400' : pf >= 1 ? 'text-amber-400' : 'text-red-400'}
            />
            <KPICard
              label="Total R"
              value={`${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`}
              sub={`avg ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R / trade`}
              color={totalR >= 0 ? 'text-emerald-400' : 'text-red-400'}
            />
            <KPICard
              label="Max Drawdown"
              value={`${Math.abs(maxDd).toFixed(1)}%`}
              sub={`${botState.update_count} AI fine-tunes`}
              color={Math.abs(maxDd) < 5 ? 'text-emerald-400' : Math.abs(maxDd) < 15 ? 'text-amber-400' : 'text-red-400'}
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Equity Curve */}
            <section className="lg:col-span-2 bg-[#0d1220]/80 border border-white/[0.07] rounded-2xl p-5">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-5">
                Equity Curve
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={equityData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fill: '#475569', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: '#475569', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
                    width={52}
                  />
                  <Tooltip content={<ChartTooltip fmt={fmt$$} />} />
                  <ReferenceLine
                    y={INITIAL_EQUITY}
                    stroke="rgba(255,255,255,0.08)"
                    strokeDasharray="5 5"
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    fill="url(#eqGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#22d3ee', stroke: '#07090f', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </section>

            {/* R Distribution */}
            <section className="bg-[#0d1220]/80 border border-white/[0.07] rounded-2xl p-5">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-5">
                R-Multiple Distribution
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={histData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
                  <XAxis
                    dataKey="bin"
                    tick={{ fill: '#475569', fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    interval={2}
                  />
                  <YAxis
                    tick={{ fill: '#475569', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    width={28}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <ReferenceLine x="0.00" stroke="rgba(248,113,113,0.35)" strokeDasharray="4 4" />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={24}>
                    {histData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.positive ? '#34d399' : '#f87171'}
                        fillOpacity={0.75}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </section>
          </div>

          {/* Drawdown */}
          <section className="bg-[#0d1220]/80 border border-white/[0.07] rounded-2xl p-5">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-5">
              Drawdown
            </h2>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={ddData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#f87171" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tick={{ fill: '#475569', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  width={48}
                />
                <Tooltip content={<ChartTooltip fmt={(v) => `${v.toFixed(2)}%`} />} />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#f87171"
                  strokeWidth={1.5}
                  fill="url(#ddGrad)"
                  dot={false}
                  activeDot={{ r: 3, fill: '#f87171', stroke: '#07090f', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </section>

          {/* AI Learning */}
          <section className="bg-[#0d1220]/80 border border-white/[0.07] rounded-2xl p-5">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-5">
              🤖 Online Learning
            </h2>
            <div className="grid grid-cols-3 gap-3 mb-5">
              <KPICard label="Model Fine-tunes" value={String(botState.update_count)} />
              <KPICard
                label="Trade Buffer"
                value={String(bufferSize)}
                sub="trades collected"
              />
              <KPICard
                label="Next Update In"
                value={`${Math.max(0, 30 - bufferSize)} trades`}
                color={bufferSize >= 25 ? 'text-amber-400' : 'text-slate-100'}
              />
            </div>
            <div className="relative w-full h-2.5 bg-white/[0.05] rounded-full overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                style={{
                  width: `${bufferPct}%`,
                  background: 'linear-gradient(90deg, #22d3ee, #34d399)',
                  boxShadow: '0 0 12px rgba(34,211,238,0.4)',
                }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              {bufferSize} / 30 trades to next PPO fine-tune
            </p>
          </section>

          {/* Trade Log */}
          <section className="bg-[#0d1220]/80 border border-white/[0.07] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Trade Log
              </h2>
              <span className="text-[11px] text-slate-600">{n} total · showing last 50</span>
            </div>

            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-white/[0.05] text-[10px] text-slate-500 uppercase tracking-widest">
                    {['Closed At', 'Side', 'Entry', 'Exit', 'R', 'Reason', 'Equity'].map(
                      (h, i) => (
                        <th
                          key={h}
                          className={`pb-3 font-semibold ${i === 0 || i === 5 ? 'text-left' : i === 1 ? 'text-center' : 'text-right'} pr-3`}
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {[...trades]
                    .reverse()
                    .slice(0, 50)
                    .map((t, i) => (
                      <tr
                        key={i}
                        className="border-b border-white/[0.03] hover:bg-white/[0.025] transition-colors group"
                      >
                        <td className="py-3 pr-3 text-slate-400 text-[11px] whitespace-nowrap font-mono">
                          {fmtTime(t.exit_time)}
                        </td>
                        <td className="py-3 pr-3 text-center">
                          <span
                            className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md ${
                              t.direction === 1
                                ? 'text-emerald-400 bg-emerald-400/[0.12]'
                                : 'text-rose-400 bg-rose-400/[0.12]'
                            }`}
                          >
                            {t.direction === 1 ? 'LONG' : 'SHORT'}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-right font-mono text-slate-300 text-xs">
                          {t.entry_price.toFixed(2)}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono text-slate-300 text-xs">
                          {t.exit_price.toFixed(2)}
                        </td>
                        <td
                          className={`py-3 pr-3 text-right font-mono font-bold text-xs ${
                            t.r_mult > 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {t.r_mult > 0 ? '+' : ''}
                          {t.r_mult.toFixed(2)}R
                        </td>
                        <td className="py-3 pr-3 text-slate-500 text-[11px] max-w-[120px] truncate">
                          {t.reason}
                        </td>
                        <td className="py-3 text-right font-mono text-xs text-slate-300">
                          {fmt$$(t.equity)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
