import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'live.opendj.template',
  appName: 'opendj-template',
  webDir: 'dist/opendj-template/browser',
  // Native iOS/Android platforms are intentionally NOT added here.
  // The hosted product (opendj-live) wraps this Angular app via Capacitor in its own apps/mobile project.
};

export default config;
