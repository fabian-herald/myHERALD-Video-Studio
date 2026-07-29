import {randomUUID, timingSafeEqual} from "node:crypto";

export interface PendingApproval {
  token: string;
  videoId: string;
  kind: string;
  costUsd: number;
  detail: string;
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000;

/**
 * Approval tokens exist so that spending money is structurally impossible for the
 * agent rather than merely discouraged by a prompt.
 *
 * A token is minted only by a request that came from the user's own click, it is
 * bound to one video and one exact cost, and it is consumed on use. An agent that
 * has been talked into calling a paid tool by something it read on a web page still
 * has no token, so the call fails at the boundary instead of at the invoice.
 */
const pending = new Map<string, PendingApproval>();

export function requestApproval(options: {
  videoId: string;
  kind: string;
  costUsd: number;
  detail: string;
}): PendingApproval {
  sweep();
  const approval: PendingApproval = {
    token: randomUUID(),
    videoId: options.videoId,
    kind: options.kind,
    costUsd: Number(options.costUsd.toFixed(4)),
    detail: options.detail,
    createdAt: Date.now(),
  };
  pending.set(approval.token, approval);
  return approval;
}

export class ApprovalError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "ApprovalError";
    this.status = status;
  }
}

/**
 * Consume a token. The caller must independently state what it believes the cost is;
 * a mismatch means the estimate moved between the click and the call, so the charge
 * is refused rather than silently applied at the new price.
 */
export function consumeApproval(options: {
  token: string;
  videoId: string;
  kind: string;
  confirmedCostUsd: number;
}): PendingApproval {
  sweep();
  const approval = pending.get(options.token);
  if (!approval) throw new ApprovalError("No pending approval matches this token.", 403);

  if (!constantTimeEqual(approval.token, options.token)) {
    throw new ApprovalError("Approval token mismatch.", 403);
  }
  if (approval.videoId !== options.videoId || approval.kind !== options.kind) {
    throw new ApprovalError("This approval was issued for a different action.", 403);
  }
  if (Math.abs(approval.costUsd - options.confirmedCostUsd) > 0.0001) {
    throw new ApprovalError(
      `Cost changed since approval: approved $${approval.costUsd.toFixed(4)}, `
      + `now $${options.confirmedCostUsd.toFixed(4)}. Re-approve to continue.`,
    );
  }

  pending.delete(options.token);
  return approval;
}

export function cancelApproval(token: string) {
  pending.delete(token);
}

export const pendingApprovals = () => [...pending.values()];

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, approval] of pending) {
    if (approval.createdAt < cutoff) pending.delete(token);
  }
}

function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
