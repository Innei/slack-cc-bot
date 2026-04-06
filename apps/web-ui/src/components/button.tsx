import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-gray-900 text-white hover:bg-black',
  secondary: 'bg-white text-gray-900 hover:bg-gray-50',
};

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-[14px] font-medium transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-[var(--color-focus)] ${VARIANT_CLASSES[variant]} ${className}`}
      style={
        variant === 'secondary' ? { boxShadow: '0px 0px 0px 1px rgb(235, 235, 235)' } : undefined
      }
      {...props}
    >
      {children}
    </button>
  );
}
