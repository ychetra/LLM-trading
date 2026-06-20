import { NextRequest, NextResponse } from 'next/server';
import { getTrades, addTrades, clearTrades } from '@/lib/store';

export async function GET() {
  const trades = await getTrades();
  return NextResponse.json(trades);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  await addTrades(body);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await clearTrades();
  return NextResponse.json({ ok: true });
}
