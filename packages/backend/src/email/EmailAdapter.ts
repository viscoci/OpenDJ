/**
 * EmailAdapter — pluggable outbound-email transport.
 *
 * Why an interface: every deployer ships a different relay (SMTP via
 * postfix/sendgrid, SES, Postmark, etc.) and the OSS demo can't pick one
 * for them. The default `ConsoleEmailAdapter` writes to stdout so the
 * verification link still surfaces during local testing without touching
 * any real email infrastructure. Tests use `InMemoryEmailAdapter` so
 * assertions can read what was sent.
 *
 * The adapter is *not* responsible for templating — services pass fully-
 * rendered text/html. Keeps the surface small and lets templating evolve
 * in the service layer without breaking adapters.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain-text body. Always present. */
  text: string;
  /** Optional HTML body. When absent, clients render the text. */
  html?: string;
  /** Override the default From: address. */
  from?: string;
  /** Tags / categories for the underlying provider's analytics. */
  tags?: ReadonlyArray<string>;
}

export interface EmailAdapter {
  send(email: OutboundEmail): Promise<void>;
}

/**
 * Default adapter for the OSS demo: logs the email to stdout and resolves.
 * Useful for local development where you want to see verification links
 * without setting up SMTP. NEVER use in production — emails go nowhere.
 */
export class ConsoleEmailAdapter implements EmailAdapter {
  constructor(private readonly logger: { log: (msg: string) => void } = console) {}

  async send(email: OutboundEmail): Promise<void> {
    const lines = [
      `[opendj-email] ${email.subject}`,
      `  to: ${email.to}`,
      ...(email.from ? [`  from: ${email.from}`] : []),
      `  ---`,
      ...email.text.split('\n').map((l) => `  ${l}`),
    ];
    this.logger.log(lines.join('\n'));
  }
}

/**
 * Test adapter — captures every send to a Map keyed by recipient. Tests
 * read `getSent(to)` to assert the right email went out with the right
 * token in it.
 */
export class InMemoryEmailAdapter implements EmailAdapter {
  private readonly bySent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.bySent.push(email);
  }

  /** All emails sent during the test, in send order. */
  all(): ReadonlyArray<OutboundEmail> {
    return [...this.bySent];
  }

  /** Most recent email matching `to`, or undefined if none. */
  lastFor(to: string): OutboundEmail | undefined {
    for (let i = this.bySent.length - 1; i >= 0; i -= 1) {
      const email = this.bySent[i]!;
      if (email.to === to) return email;
    }
    return undefined;
  }

  reset(): void {
    this.bySent.length = 0;
  }
}
