import { motion } from 'motion/react';

import { Card, CardDescription, CardTitle } from '~/components/card';

const SETTINGS_SECTIONS = [
  {
    title: 'Slack Connection',
    description: 'Bot token, app token, and signing secret configuration.',
  },
  {
    title: 'Claude Provider',
    description: 'Model selection, max turns, and permission mode settings.',
  },
  {
    title: 'Repository Scanning',
    description: 'Repository root directory, scan depth, and workspace discovery.',
  },
  {
    title: 'Logging',
    description: 'Log level, file output, and structured logging preferences.',
  },
] as const;

export function SettingsPage() {
  return (
    <div>
      <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 8 }}>
        <h1
          className="text-[48px] font-semibold text-gray-900"
          style={{ letterSpacing: '-2.4px', lineHeight: '1.17' }}
        >
          Settings
        </h1>
        <p className="mt-3 text-[20px] leading-relaxed text-gray-600">
          Configure bot behavior and environment settings.
        </p>
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10 grid gap-4 sm:grid-cols-2"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        {SETTINGS_SECTIONS.map((section) => (
          <Card key={section.title}>
            <CardTitle>{section.title}</CardTitle>
            <CardDescription>{section.description}</CardDescription>
          </Card>
        ))}
      </motion.div>
    </div>
  );
}
