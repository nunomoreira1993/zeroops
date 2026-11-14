import { z } from 'zod';
import type { Role, TicketStatus } from './index.js';

export const preExecutionStatuses: readonly TicketStatus[] = [
  'new',
  'investigating',
  'awaiting_information',
  'awaiting_client',
  'awaiting_technical',
  'awaiting_confirmation',
  'blocked',
];

export interface TicketParticipant {
  userId: string;
  displayName: string;
  role: Role;
  organization: 'client' | 'deloitte' | null;
  required: boolean;
}
export const participantInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  userId: z.uuid(),
  action: z.enum(['add', 'remove']),
});
export const resolutionInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  body: z.string().trim().min(10).max(20000),
});
export interface TicketResolution {
  id: string;
  body: string;
  hash: string;
  authorName: string;
  clientId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  notes: string | null;
}
export interface DependencyInvalidation {
  id: string;
  ticketVersion: number;
  actorName: string;
  reason: string;
  createdAt: string;
}
