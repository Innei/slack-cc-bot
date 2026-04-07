import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

import { Badge } from '~/components/badge';
import { Card, CardDescription, CardTitle } from '~/components/card';
import { useSettings } from '~/hooks/use-api';

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings();

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
        className="mt-10"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="size-5 animate-spin text-gray-400" strokeWidth={1.5} />
          </div>
        ) : settings ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardTitle>Slack Connection</CardTitle>
              <CardDescription>Bot token and socket mode configuration.</CardDescription>
              <div className="mt-4">
                <Badge variant={settings.slackConnected ? 'success' : 'error'}>
                  {settings.slackConnected ? 'Connected' : 'Disconnected'}
                </Badge>
              </div>
            </Card>

            <Card>
              <CardTitle>Claude Provider</CardTitle>
              <CardDescription>Model selection and turn limits.</CardDescription>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge>{settings.claudeModel}</Badge>
                <Badge>Max {settings.claudeMaxTurns} turns</Badge>
              </div>
            </Card>

            <Card>
              <CardTitle>Repository Scanning</CardTitle>
              <CardDescription>Workspace discovery configuration.</CardDescription>
              <div className="mt-4 space-y-1 text-[13px] text-gray-500 font-mono">
                <p>root: {settings.repoRootDir}</p>
                <p>depth: {settings.repoScanDepth}</p>
              </div>
            </Card>

            <Card>
              <CardTitle>Logging</CardTitle>
              <CardDescription>Log level and output preferences.</CardDescription>
              <div className="mt-4">
                <Badge>{settings.logLevel}</Badge>
              </div>
            </Card>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
