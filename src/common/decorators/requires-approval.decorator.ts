import { SetMetadata } from '@nestjs/common';

export const REQUIRES_APPROVAL_KEY = 'requiresApproval';

export interface ApprovalMetadata {
  actionType: string;
  resourceType: string;
}

export const RequiresApproval = (actionType: string, resourceType: string) =>
  SetMetadata(REQUIRES_APPROVAL_KEY, { actionType, resourceType } satisfies ApprovalMetadata);
