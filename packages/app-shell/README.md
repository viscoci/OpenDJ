# @opendj/app-shell

Platform-neutral app-shell interfaces. Feature components depend on this package; concrete browser/Capacitor adapters are wired by the consuming app.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"App shell and native platform adapters"):

- `AppShell` interface (`getPlatform`, `isNative`, `openExternalUrl`, `share`, `copyToClipboard`, `refreshRealtimeSnapshotOnResume`)
- `NativeAuthAdapter` interface (system-browser OAuth flow + secure native session storage)
- `BrowserAppShell` adapter (links, Web Share API, Clipboard API, httpOnly cookie sessions)
- Capacitor adapters (introduced per-feature; live in `opendj-live` mobile app)

Rule: Capacitor-specific code lives in adapter implementations, never in feature components. OSS remains runnable as a normal web app without Xcode or Android Studio.
