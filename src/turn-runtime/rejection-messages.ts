import type { Gate } from '../settings';
import type { ImageRequestRejectionReason } from '../image-requests/image-request-dispatcher';
import type { AnimateRequestRejectionReason } from '../image-requests/animate-request-dispatcher';

export type RejectionReason = Exclude<Gate, 'open'> | ImageRequestRejectionReason | AnimateRequestRejectionReason;

export const rejectionUserMessage: Record<RejectionReason, string> = {
  closed: "I'm unavailable right now. Please try again later.",
  paused: "I'm unavailable right now. Please try again later.",
  text_only: "I'm unavailable right now. Please try again later.",
};
