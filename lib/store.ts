import { promises as fs } from 'fs';
import path from 'path';

const DIR = '/tmp';
const TRADES_FILE = path.join(DIR, 'llm_trades.json');
const STATE_FILE = path.join(DIR, 'llm_state.json');

export interface RawTrade {
  entry_time: string;
  exit_time: string;
  direction: number;
  entry_price: number;
  exit_price: number;
  r_mult: number;
  reason: string;
}

export interface LearnerState {
  update_count: number;
  trade_buffer: RawTrade[];
}

export async function getTrades(): Promise<RawTrade[]> {
  try {
    return JSON.parse(await fs.readFile(TRADES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

export async function addTrades(payload: RawTrade | RawTrade[]): Promise<void> {
  const existing = await getTrades();
  const next = [...existing, ...(Array.isArray(payload) ? payload : [payload])];
  await fs.writeFile(TRADES_FILE, JSON.stringify(next));
}

export async function clearTrades(): Promise<void> {
  await fs.writeFile(TRADES_FILE, '[]');
}

export async function getState(): Promise<LearnerState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
  } catch {
    return { update_count: 0, trade_buffer: [] };
  }
}

export async function setState(s: LearnerState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(s));
}
