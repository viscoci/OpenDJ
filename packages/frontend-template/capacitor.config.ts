import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'live.opendj.template',
  appName: 'opendj-template',
  webDir: 'dist/opendj-template/browser',
  // Native iOS/Android platforms are intentionally NOT added here.
  // Capacitor-ready by design — downstream consumers can wrap this Angular
  // app in their own native shell project without changing app code.
};

export default config;
