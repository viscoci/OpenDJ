/**
 * Current enforcement state for a subject (a hashed identifier — fingerprint,
 * IP, device, etc.). Mirrors `abuse_subjects`.
 */

export type AbuseSubjectStatus = 'normal' | 'throttled' | 'shadow_limited' | 'blocked';

export interface AbuseSubject {
  subjectHash: string;
  accountId?: string;
  sessionId?: string;
  riskScore: number;
  status: AbuseSubjectStatus;
  reason?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Status auto-clears after this time. null = sticky until manual review. */
  expiresAt: Date | null;
}
