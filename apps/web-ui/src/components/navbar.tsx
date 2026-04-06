import { Bot, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';

const NAV_ITEMS = [
  { label: 'Dashboard', path: '/' },
  { label: 'Sessions', path: '/sessions' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Settings', path: '/settings' },
] as const;

export function Navbar() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header
      className="sticky top-0 z-50 bg-white/80 backdrop-blur-sm"
      style={{ boxShadow: '0px 0px 0px 1px rgba(0, 0, 0, 0.08)' }}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <Link className="flex items-center gap-2.5" to="/">
          <Bot className="size-6 text-gray-900" strokeWidth={1.5} />
          <span
            className="text-[16px] font-semibold text-gray-900"
            style={{ letterSpacing: '-0.32px' }}
          >
            Slack CC Bot
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            const active =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                style={active ? { letterSpacing: '-0.32px' } : undefined}
                to={item.path}
                className={`rounded-md px-3 py-1.5 text-[14px] font-medium transition-colors ${
                  active ? 'font-semibold text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <button
          aria-label="Toggle menu"
          className="flex size-9 items-center justify-center rounded-full text-gray-900 md:hidden"
          style={{ boxShadow: '0px 0px 0px 1px rgb(235, 235, 235)' }}
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {mobileOpen && (
        <nav className="border-t border-gray-100 px-6 py-3 md:hidden">
          {NAV_ITEMS.map((item) => {
            const active =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`block rounded-md px-3 py-2 text-[14px] font-medium ${
                  active ? 'font-semibold text-gray-900' : 'text-gray-500'
                }`}
                onClick={() => setMobileOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
