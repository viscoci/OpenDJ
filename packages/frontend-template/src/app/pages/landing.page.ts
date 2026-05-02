import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-landing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <section>
        <p class="eyebrow">OpenDJ — open-source collaborative music queue</p>
        <h1>Scan the QR.<br />Queue your song.</h1>
        <p class="lede">
          The OSS template. Hosts go to <code>/host</code> to sign in and create a session; guests
          land at <code>/u/&lt;slug&gt;</code> via QR code.
        </p>
        <a class="cta" href="https://github.com/viscoci/opendj">View on GitHub →</a>
      </section>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        background: #0c0a14;
        color: #f3eef9;
        min-height: 100dvh;
        font-family:
          'Inter',
          -apple-system,
          BlinkMacSystemFont,
          'Segoe UI',
          Roboto,
          sans-serif;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 80px 24px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-size: 13px;
        color: #a294c5;
        margin: 0 0 12px;
      }
      h1 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 56px;
        line-height: 1.05;
        margin: 0 0 24px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .lede {
        font-size: 18px;
        color: #c8b8e9;
        max-width: 520px;
        margin: 0 0 28px;
      }
      code {
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #1a1525;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.9em;
      }
      .cta {
        display: inline-block;
        padding: 14px 22px;
        border-radius: 12px;
        background: linear-gradient(135deg, #a855f7, #ec4899);
        color: white;
        text-decoration: none;
        font-weight: 600;
      }
    `,
  ],
})
export class LandingPage {}
