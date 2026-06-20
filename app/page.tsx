'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  Pie, PieChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, ArrowDownRight, ArrowUpRight, Award, BarChart2,
  Bot, Flame, RefreshCw, Shield, Target, TrendingDown,
  TrendingUp, Zap, ChevronRight, Clock,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
interface RawTrade {
  entry_time: string; exit_time: string; direction: number;
  entry_price: number; exit_price: number; r_mult: number; reason: string;
}
interface Trade extends RawTrade {
  equity: number; pnl: number; cumulative_r: number; drawdown_pct: number; idx: number;
}
interface BotState { update_count: number; trade_buffer: RawTrade[]; }

// ── Constants ──────────────────────────────────────────────────────────────────
const INIT_EQ = 10_000;
const RISK    = INIT_EQ * 0.005;

// ── Utils ──────────────────────────────────────────────────────────────────────
function process(raw: RawTrade[]): Trade[] {
  const s = [...raw].sort((a, b) => +new Date(a.exit_time) - +new Date(b.exit_time));
  let eq = INIT_EQ, cumR = 0, peak = INIT_EQ;
  return s.map((t, idx) => {
    const pnl = t.r_mult * RISK;
    eq += pnl; cumR += t.r_mult;
    if (eq > peak) peak = eq;
    return { ...t, equity: eq, pnl, cumulative_r: cumR, drawdown_pct: -((peak - eq) / peak) * 100, idx };
  });
}

function histo(vals: number[], n = 16) {
  if (!vals.length) return [];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const sz = (hi - lo) / n;
  return Array.from({ length: n }, (_, i) => {
    const a = lo + i * sz, b = a + sz, mid = (a + b) / 2;
    return { r: mid.toFixed(1), n: vals.filter(v => i === n - 1 ? v >= a && v <= b : v >= a && v < b).length, pos: mid >= 0 };
  });
}

function getStreak(trades: Trade[]) {
  if (!trades.length) return { count: 0, type: 'win' as const };
  const rev = [...trades].reverse();
  const type = rev[0].r_mult > 0 ? 'win' as const : 'loss' as const;
  let count = 0;
  for (const t of rev) { if ((t.r_mult > 0) === (type === 'win')) count++; else break; }
  return { count, type };
}

function grade(pf: number) {
  if (pf >= 2.5) return { g: 'A+', c: '#4ade80' };
  if (pf >= 2.0) return { g: 'A',  c: '#4ade80' };
  if (pf >= 1.5) return { g: 'B',  c: '#a3e635' };
  if (pf >= 1.2) return { g: 'C',  c: '#fbbf24' };
  if (pf >= 1.0) return { g: 'D',  c: '#fb923c' };
  return { g: 'F', c: '#f87171' };
}

const $$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

// ── Reusable chart tooltip ────────────────────────────────────────────────────
function Tip({ active, payload, label, fmt = String }: {
  active?: boolean; payload?: { value: number; color?: string }[]; label?: string; fmt?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'rgba(5,7,15,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '8px 14px', fontSize: 11, backdropFilter: 'blur(12px)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
      <p style={{ color: '#475569', marginBottom: 5, fontWeight: 500 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color ?? '#818cf8', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
          {fmt(p.value)}
        </p>
      ))}
    </div>
  );
}

// ── Win-rate donut ────────────────────────────────────────────────────────────
function WinDonut({ wins, losses, winRate }: { wins: number; losses: number; winRate: number }) {
  return (
    <div className="relative w-28 h-28 mx-auto">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={[{ v: wins }, { v: Math.max(losses, 0.01) }]} dataKey="v"
            cx="50%" cy="50%" innerRadius={38} outerRadius={52}
            paddingAngle={wins && losses ? 3 : 0} startAngle={90} endAngle={-270} stroke="none">
            <Cell fill="#4ade80" />
            <Cell fill="rgba(255,255,255,0.05)" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-lg font-bold text-slate-100 mono">{winRate.toFixed(0)}<span className="text-sm">%</span></span>
        <span className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Win</span>
      </div>
    </div>
  );
}

// ── Skeleton loader ───────────────────────────────────────────────────────────
function Sk({ cls }: { cls: string }) {
  return <div className={`rounded-2xl shimmer ${cls}`} />;
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KPI({ icon, label, value, sub, valueClass = 'text-slate-100', glow = '' }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; valueClass?: string; glow?: string;
}) {
  return (
    <div className={`glass glass-hover rounded-2xl p-4 transition-all ${glow}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="w-8 h-8 rounded-xl bg-white/[0.06] flex items-center justify-center text-slate-500">
          {icon}
        </div>
      </div>
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-[0.15em] mb-1.5">{label}</p>
      <p className={`text-[1.6rem] font-bold leading-none mono ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-600 mt-2 leading-tight">{sub}</p>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'trades' | 'ai';

export default function Dashboard() {
  const [trades, setTrades]   = useState<Trade[]>([]);
  const [state,  setState_]   = useState<BotState>({ update_count: 0, trade_buffer: [] });
  const [stamp,  setStamp]    = useState('');
  const [loading, setLoading] = useState(true);
  const [spin,    setSpin]    = useState(false);
  const [tab,     setTab]     = useState<Tab>('overview');
  const [page,    setPage]    = useState(1);
  const PER_PAGE = 20;

  const load = useCallback(async (manual = false) => {
    if (manual) setSpin(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/trades', { cache: 'no-store' }),
        fetch('/api/state',  { cache: 'no-store' }),
      ]);
      setTrades(process(await tRes.json()));
      setState_(await sRes.json());
      setStamp(new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC');
    } catch { /* keep stale */ }
    finally { setLoading(false); setSpin(false); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  // ── Derived stats ────────────────────────────────────────────────────────
  const n        = trades.length;
  const wins     = trades.filter(t => t.r_mult > 0).length;
  const losses   = trades.filter(t => t.r_mult <= 0).length;
  const winRate  = n ? (wins / n) * 100 : 0;
  const totalR   = trades.reduce((s, t) => s + t.r_mult, 0);
  const avgR     = n ? totalR / n : 0;
  const grossW   = trades.filter(t => t.r_mult > 0).reduce((s, t) => s + t.r_mult, 0);
  const grossL   = Math.abs(trades.filter(t => t.r_mult <= 0).reduce((s, t) => s + t.r_mult, 0));
  const pf       = grossL > 0 ? grossW / grossL : Infinity;
  const curEq    = trades.at(-1)?.equity ?? INIT_EQ;
  const pnl      = curEq - INIT_EQ;
  const maxDd    = n ? Math.min(...trades.map(t => t.drawdown_pct)) : 0;
  const bestT    = n ? trades.reduce((a, b) => b.r_mult > a.r_mult ? b : a) : null;
  const worstT   = n ? trades.reduce((a, b) => b.r_mult < a.r_mult ? b : a) : null;
  const { count: strCount, type: strType } = useMemo(() => getStreak(trades), [trades]);
  const { g: grLetter, c: grColor }        = useMemo(() => grade(pf), [pf]);
  const bufSize  = state.trade_buffer?.length ?? 0;
  const bufPct   = Math.min(bufSize / 30, 1) * 100;

  // chart data
  const eqData   = trades.map(t => ({ x: fmtDate(t.exit_time), v: +t.equity.toFixed(2) }));
  const ddData   = trades.map(t => ({ x: fmtDate(t.exit_time), v: +t.drawdown_pct.toFixed(3) }));
  const histData = useMemo(() => histo(trades.map(t => t.r_mult)), [trades]);
  const cumRData = trades.map(t => ({ x: fmtDate(t.exit_time), v: +t.cumulative_r.toFixed(2) }));

  // paginated trades
  const totalPages = Math.max(1, Math.ceil(n / PER_PAGE));
  const pageTrades = useMemo(() => [...trades].reverse().slice((page - 1) * PER_PAGE, page * PER_PAGE), [trades, page]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 glass border-b border-white/[0.05] px-6 py-3">
        <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-4">

          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
              <TrendingUp size={15} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-100 tracking-tight leading-none">XAUUSD RL Trader</h1>
              <p className="text-[10px] text-slate-500 leading-none mt-0.5">Reinforcement Learning Bot</p>
            </div>
          </div>

          {/* Center — ticker style */}
          {n > 0 && (
            <div className="hidden md:flex items-center gap-6 text-xs mono">
              <span className="text-slate-500">EQ</span>
              <span className={`font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{$$(curEq)}</span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-500">P&L</span>
              <span className={`font-semibold flex items-center gap-0.5 ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {pnl >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                {$$(Math.abs(pnl))}
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-500">WR</span>
              <span className={`font-bold ${winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{winRate.toFixed(1)}%</span>
            </div>
          )}

          {/* Right */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-400/[0.08] border border-emerald-400/20 px-2.5 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-ring" />
              LIVE
            </div>
            {stamp && <span className="hidden sm:block text-[10px] text-slate-600 mono">{stamp}</span>}
            <button onClick={() => load(true)} disabled={spin}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.07] px-3 py-1.5 rounded-xl transition-all disabled:opacity-40">
              <RefreshCw size={12} className={spin ? 'spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Tab nav ───────────────────────────────────────────────────────── */}
      <div className="border-b border-white/[0.05] bg-surface-1/60 backdrop-blur-sm">
        <div className="max-w-[1440px] mx-auto px-6 flex gap-0">
          {(['overview', 'trades', 'ai'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-3.5 text-xs font-semibold uppercase tracking-widest transition-all ${tab === t ? 'tab-active' : 'tab-inactive'}`}>
              {t === 'overview' ? 'Overview' : t === 'trades' ? `Trades${n ? ` (${n})` : ''}` : 'AI Learning'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-[1440px] mx-auto w-full px-4 md:px-6 py-6">

        {/* Loading */}
        {loading && (
          <div className="space-y-4 fade-up">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {Array(6).fill(0).map((_, i) => <Sk key={i} cls="h-24" />)}
            </div>
            <div className="grid lg:grid-cols-3 gap-4">
              <Sk cls="lg:col-span-2 h-72" />
              <Sk cls="h-72" />
            </div>
          </div>
        )}

        {/* Empty */}
        {!loading && n === 0 && (
          <div className="flex flex-col items-center justify-center py-32 text-center fade-up">
            <div className="w-20 h-20 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
              <Activity size={32} className="text-indigo-400" />
            </div>
            <h2 className="text-xl font-bold text-slate-200 mb-2">No trades yet</h2>
            <p className="text-slate-500 text-sm max-w-xs mb-8 leading-relaxed">
              Start the trading bot — it will push trades here live as they close.
            </p>
            <code className="glass border border-white/10 text-indigo-300 text-sm px-5 py-3 rounded-xl mono">
              python run_live.py
            </code>
          </div>
        )}

        {/* ── OVERVIEW TAB ───────────────────────────────────────────────── */}
        {!loading && n > 0 && tab === 'overview' && (
          <div className="space-y-4 fade-up">

            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <KPI icon={<TrendingUp size={15} />} label="Equity"
                value={$$(curEq)}
                sub={`${pnl >= 0 ? '+' : ''}${$$(pnl)} P&L`}
                valueClass={pnl >= 0 ? 'grad-green' : 'grad-red'}
                glow={pnl >= 0 ? 'glow-green' : 'glow-red'}
              />
              <KPI icon={<BarChart2 size={15} />} label="Total Trades"
                value={String(n)}
                sub={`${wins} wins · ${losses} losses`}
              />
              <KPI icon={<Target size={15} />} label="Win Rate"
                value={`${winRate.toFixed(1)}%`}
                sub={`Avg R: ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`}
                valueClass={winRate >= 55 ? 'grad-green' : winRate >= 45 ? 'text-amber-400' : 'grad-red'}
              />
              <KPI icon={<Shield size={15} />} label="Profit Factor"
                value={isFinite(pf) ? pf.toFixed(2) : '∞'}
                sub={`Grade: ${grLetter}`}
                valueClass={pf >= 1.5 ? 'grad-green' : pf >= 1 ? 'text-amber-400' : 'grad-red'}
              />
              <KPI icon={<Zap size={15} />} label="Total R"
                value={`${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`}
                sub={`${wins}W gross: +${grossW.toFixed(2)}R`}
                valueClass={totalR >= 0 ? 'grad-cyan' : 'grad-red'}
              />
              <KPI icon={<TrendingDown size={15} />} label="Max Drawdown"
                value={`${Math.abs(maxDd).toFixed(2)}%`}
                sub={`${strCount} ${strType} streak ${strType === 'win' ? '🔥' : '📉'}`}
                valueClass={Math.abs(maxDd) < 5 ? 'text-emerald-400' : Math.abs(maxDd) < 15 ? 'text-amber-400' : 'grad-red'}
              />
            </div>

            {/* Main row: equity chart + right panel */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Equity curve */}
              <section className="lg:col-span-2 glass rounded-2xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Equity Curve</h2>
                    <p className="text-[10px] text-slate-600 mt-0.5">Starting capital ${(INIT_EQ/1000).toFixed(0)}k</p>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] mono">
                    <span className="flex items-center gap-1 text-indigo-400">
                      <span className="inline-block w-6 h-0.5 bg-indigo-400 rounded" />
                      Equity
                    </span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={eqData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#6366f1" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#6366f1" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.025)" vertical={false} />
                    <XAxis dataKey="x" tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false}
                      tickFormatter={v => `$${(v/1000).toFixed(1)}k`} width={50} domain={['auto', 'auto']} />
                    <Tooltip content={<Tip fmt={$$} />} />
                    <ReferenceLine y={INIT_EQ} stroke="rgba(255,255,255,0.06)" strokeDasharray="6 4" />
                    <Area type="monotone" dataKey="v" stroke="#818cf8" strokeWidth={2.5}
                      fill="url(#eqGrad)" dot={false}
                      activeDot={{ r: 5, fill: '#818cf8', stroke: '#05070f', strokeWidth: 2.5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </section>

              {/* Right panel */}
              <div className="flex flex-col gap-4">

                {/* Win rate + grade */}
                <section className="glass rounded-2xl p-5">
                  <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">Performance</h2>
                  <div className="flex items-center gap-4">
                    <WinDonut wins={wins} losses={losses} winRate={winRate} />
                    <div className="flex-1 space-y-3">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Strategy Grade</p>
                        <p className="text-3xl font-black mono" style={{ color: grColor }}>{grLetter}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[10px] text-slate-600">Best</p>
                          <p className="text-xs font-bold text-emerald-400 mono">
                            {bestT ? `+${bestT.r_mult.toFixed(2)}R` : '—'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-600">Worst</p>
                          <p className="text-xs font-bold text-rose-400 mono">
                            {worstT ? `${worstT.r_mult.toFixed(2)}R` : '—'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Cumulative R */}
                <section className="glass rounded-2xl p-5 flex-1">
                  <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">Cumulative R</h2>
                  <ResponsiveContainer width="100%" height={110}>
                    <AreaChart data={cumRData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="rGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#22d3ee" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <YAxis tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} width={28}
                        tickFormatter={v => `${v}R`} />
                      <Tooltip content={<Tip fmt={v => `${v > 0 ? '+' : ''}${v.toFixed(2)}R`} />} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.06)" />
                      <Area type="monotone" dataKey="v" stroke="#22d3ee" strokeWidth={2}
                        fill="url(#rGrad)" dot={false}
                        activeDot={{ r: 4, fill: '#22d3ee', stroke: '#05070f', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </section>
              </div>
            </div>

            {/* R histogram + Drawdown */}
            <div className="grid md:grid-cols-2 gap-4">

              {/* R Distribution */}
              <section className="glass rounded-2xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">R-Multiple Distribution</h2>
                    <p className="text-[10px] text-slate-600 mt-0.5">Positive skew = edge exists</p>
                  </div>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1 text-emerald-400"><span className="w-2 h-2 rounded-sm bg-emerald-400/70 inline-block" />Win</span>
                    <span className="flex items-center gap-1 text-rose-400"><span className="w-2 h-2 rounded-sm bg-rose-400/70 inline-block" />Loss</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={histData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.025)" vertical={false} />
                    <XAxis dataKey="r" tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
                    <YAxis tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} width={24} allowDecimals={false} />
                    <Tooltip content={<Tip fmt={v => `${v} trades`} />} />
                    <ReferenceLine x="0.0" stroke="rgba(248,113,113,0.3)" strokeDasharray="5 4" />
                    <Bar dataKey="n" radius={[4, 4, 0, 0]} maxBarSize={28}>
                      {histData.map((d, i) => (
                        <Cell key={i} fill={d.pos ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.7)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </section>

              {/* Drawdown */}
              <section className="glass rounded-2xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Underwater Chart</h2>
                    <p className="text-[10px] text-slate-600 mt-0.5">
                      Max DD: <span className="text-rose-400 mono font-semibold">{Math.abs(maxDd).toFixed(2)}%</span>
                    </p>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={ddData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#f87171" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#f87171" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.025)" vertical={false} />
                    <XAxis dataKey="x" tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#334155', fontSize: 9 }} tickLine={false} axisLine={false} width={40}
                      tickFormatter={v => `${v.toFixed(1)}%`} />
                    <Tooltip content={<Tip fmt={v => `${v.toFixed(2)}%`} />} />
                    <Area type="monotone" dataKey="v" stroke="#f87171" strokeWidth={1.5}
                      fill="url(#ddGrad)" dot={false}
                      activeDot={{ r: 4, fill: '#f87171', stroke: '#05070f', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </section>
            </div>

            {/* Stats ribbon */}
            <section className="glass rounded-2xl p-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4 divide-x divide-white/[0.04]">
                {[
                  { label: 'Gross Win R',   val: `+${grossW.toFixed(2)}R`,  c: 'text-emerald-400' },
                  { label: 'Gross Loss R',  val: `-${grossL.toFixed(2)}R`,  c: 'text-rose-400' },
                  { label: 'Avg Win R',     val: wins ? `+${(grossW/wins).toFixed(2)}R` : '—',  c: 'text-emerald-400' },
                  { label: 'Avg Loss R',    val: losses ? `-${(grossL/losses).toFixed(2)}R` : '—', c: 'text-rose-400' },
                  { label: 'Risk/Trade',    val: `$${RISK.toFixed(0)}`,  c: 'text-slate-300' },
                  { label: 'Total PnL',     val: $$(pnl),  c: pnl >= 0 ? 'text-emerald-400' : 'text-rose-400' },
                  { label: 'Streak',        val: `${strCount} ${strType}${strCount !== 1 ? 's' : ''}`, c: strType === 'win' ? 'text-emerald-400' : 'text-rose-400' },
                  { label: 'AI Fine-tunes', val: String(state.update_count), c: 'text-violet-400' },
                ].map(({ label, val, c }) => (
                  <div key={label} className="pl-4 first:pl-0">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</p>
                    <p className={`text-sm font-bold mono ${c}`}>{val}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* ── TRADES TAB ─────────────────────────────────────────────────── */}
        {!loading && n > 0 && tab === 'trades' && (
          <div className="space-y-4 fade-up">
            <section className="glass rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.04] flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-300">Trade Log</h2>
                  <p className="text-[10px] text-slate-600 mt-0.5">{n} total trades · page {page} of {totalPages}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-3 py-1.5 text-xs glass rounded-lg disabled:opacity-30 hover:border-white/10 transition-all">←</button>
                  <span className="text-xs text-slate-500 mono">{page}/{totalPages}</span>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="px-3 py-1.5 text-xs glass rounded-lg disabled:opacity-30 hover:border-white/10 transition-all">→</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="text-[10px] text-slate-500 uppercase tracking-widest border-b border-white/[0.04]">
                      {['#', 'Closed', 'Side', 'Entry', 'Exit', 'R-Multiple', 'PnL', 'Equity', 'Reason'].map((h, i) => (
                        <th key={h} className={`py-3 px-4 font-semibold ${i <= 2 ? 'text-left' : 'text-right'} last:text-left`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageTrades.map((t, i) => {
                      const absIdx = n - ((page - 1) * PER_PAGE) - i;
                      return (
                        <tr key={t.idx}
                          className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group">
                          <td className="py-3 px-4 text-slate-600 mono text-[11px]">{absIdx}</td>
                          <td className="py-3 px-4">
                            <p className="text-[11px] text-slate-300 mono">{fmtDate(t.exit_time)}</p>
                            <p className="text-[10px] text-slate-600 mono">{fmtTime(t.exit_time)}</p>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg ${
                              t.direction === 1 ? 'text-emerald-400 bg-emerald-400/[0.1]' : 'text-rose-400 bg-rose-400/[0.1]'}`}>
                              {t.direction === 1 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                              {t.direction === 1 ? 'LONG' : 'SHORT'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right mono text-[11px] text-slate-300">{t.entry_price.toFixed(2)}</td>
                          <td className="py-3 px-4 text-right mono text-[11px] text-slate-300">{t.exit_price.toFixed(2)}</td>
                          <td className={`py-3 px-4 text-right mono font-bold text-sm ${t.r_mult > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.r_mult > 0 ? '+' : ''}{t.r_mult.toFixed(2)}R
                          </td>
                          <td className={`py-3 px-4 text-right mono text-[11px] ${t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.pnl >= 0 ? '+' : ''}{$$(t.pnl)}
                          </td>
                          <td className="py-3 px-4 text-right mono text-[11px] text-slate-300">{$$(t.equity)}</td>
                          <td className="py-3 px-4 text-slate-500 text-[11px] max-w-[100px] truncate">{t.reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ── AI LEARNING TAB ────────────────────────────────────────────── */}
        {!loading && tab === 'ai' && (
          <div className="space-y-4 fade-up">

            {/* AI KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass gradient-border rounded-2xl p-5 glow-indigo">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mb-4">
                  <Bot size={18} className="text-violet-400" />
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Model Fine-tunes</p>
                <p className="text-4xl font-black mono grad-cyan">{state.update_count}</p>
                <p className="text-xs text-slate-600 mt-2">PPO gradient updates applied</p>
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
                  <Flame size={18} className="text-amber-400" />
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Trade Buffer</p>
                <p className="text-4xl font-black mono text-amber-400">{bufSize}</p>
                <p className="text-xs text-slate-600 mt-2">Trades collected since last update</p>
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                  <Award size={18} className="text-emerald-400" />
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Next Update In</p>
                <p className="text-4xl font-black mono text-emerald-400">{Math.max(0, 30 - bufSize)}</p>
                <p className="text-xs text-slate-600 mt-2">Trades needed to trigger fine-tune</p>
              </div>
            </div>

            {/* Progress */}
            <section className="glass rounded-2xl p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-sm font-semibold text-slate-300">Fine-tune Progress</h2>
                  <p className="text-xs text-slate-500 mt-1">Collecting {bufSize} / 30 trades for next PPO update</p>
                </div>
                <span className="text-sm font-bold mono text-indigo-400">{bufPct.toFixed(0)}%</span>
              </div>
              <div className="relative h-3 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                  style={{
                    width: `${bufPct}%`,
                    background: 'linear-gradient(90deg, #6366f1, #22d3ee)',
                    boxShadow: '0 0 16px rgba(99,102,241,0.6)',
                  }} />
              </div>
              <div className="flex justify-between mt-2 text-[10px] text-slate-600 mono">
                <span>0</span><span>10</span><span>20</span><span>30 → Fine-tune</span>
              </div>
            </section>

            {/* How it works */}
            <section className="glass rounded-2xl p-6">
              <h2 className="text-sm font-semibold text-slate-300 mb-5">How Online Learning Works</h2>
              <div className="grid md:grid-cols-4 gap-4">
                {[
                  { step: '1', icon: <Activity size={16} />, title: 'Trade Closes', desc: 'Bot executes trade, records R-multiple outcome', color: 'text-cyan-400', bg: 'bg-cyan-400/10', border: 'border-cyan-400/20' },
                  { step: '2', icon: <Clock size={16} />,    title: 'Buffer Fills', desc: 'Outcome added to replay buffer (target: 30 trades)', color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/20' },
                  { step: '3', icon: <Zap size={16} />,      title: 'PPO Update', desc: 'Policy gradient optimized using buffered trajectories', color: 'text-violet-400', bg: 'bg-violet-400/10', border: 'border-violet-400/20' },
                  { step: '4', icon: <Award size={16} />,    title: 'Model Improves', desc: 'Updated policy deployed for live trading immediately', color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20' },
                ].map(({ step, icon, title, desc, color, bg, border }) => (
                  <div key={step} className="relative">
                    <div className={`w-9 h-9 rounded-xl ${bg} border ${border} flex items-center justify-center ${color} mb-3`}>
                      {icon}
                    </div>
                    <p className={`text-xs font-bold ${color} mb-1`}>Step {step} · {title}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
                    {step !== '4' && (
                      <ChevronRight size={14} className="absolute top-1.5 -right-2 text-slate-700 hidden md:block" />
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-10 pt-6 border-t border-white/[0.04] text-center text-[10px] text-slate-600">
          XAUUSD RL Trader · Auto-refreshes every 5s · Data via Railway API
        </footer>
      </main>
    </div>
  );
}
