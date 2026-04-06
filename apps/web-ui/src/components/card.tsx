import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg bg-white p-6 transition-shadow hover:shadow-[var(--shadow-card-hover)] ${className}`}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h3
      className="text-[24px] font-semibold text-gray-900"
      style={{ letterSpacing: '-0.96px', lineHeight: '1.33' }}
    >
      {children}
    </h3>
  );
}

export function CardDescription({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[16px] leading-relaxed text-gray-600">{children}</p>;
}
