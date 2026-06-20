import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'XAUUSD RL Trader',
  description: 'Live trading dashboard — XAUUSD reinforcement learning bot',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
