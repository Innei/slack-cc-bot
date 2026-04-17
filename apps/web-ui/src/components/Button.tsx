import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

import { cn } from '~/lib/cn';

type Variant = 'primary' | 'ghost' | 'subtle';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: Size;
  variant?: Variant;
}

const variantStyles: Record<Variant, string> = {
  ghost:
    'bg-white text-[color:var(--color-ink)] shadow-ring-light hover:bg-[color:var(--color-surface-tint)]',
  primary: 'bg-[color:var(--color-ink)] text-white hover:bg-black/90',
  subtle:
    'bg-[color:var(--color-surface-tint)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-line-subtle)]',
};

const sizeStyles: Record<Size, string> = {
  md: 'h-9 px-4 text-sm',
  sm: 'h-7 px-3 text-xs',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, className, size = 'md', variant = 'primary', type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);

Button.displayName = 'Button';
