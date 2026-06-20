import { NextRequest, NextResponse } from 'next/server';
import { getState, setState } from '@/lib/store';

export async function GET() {
  return NextResponse.json(await getState());
}

export async function POST(req: NextRequest) {
  await setState(await req.json());
  return NextResponse.json({ ok: true });
}
