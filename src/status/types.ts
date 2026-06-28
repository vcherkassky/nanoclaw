// src/status/types.ts
export type StatusBucket =
  | 'channels'
  | 'email'
  | 'agent'
  | 'proxy'
  | 'tasks'
  | 'system';

export interface StatusRow {
  label: string;
  value: string;
}

export interface StatusContribution {
  bucket: StatusBucket;
  title: string;
  rows: StatusRow[];
  /** Optional health flag rendered prominently above the rows. */
  warn?: string;
}

export interface StatusProvider {
  name: string;
  collect(): Promise<StatusContribution>;
}
