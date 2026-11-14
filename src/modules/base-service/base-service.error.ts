export type BaseServiceErrorCode =
  | 'EMPTY_CATALOG'
  | 'INVALID_GOAL'
  | 'INVALID_DAYS'
  | 'INVALID_MONTH'
  | 'NO_CONTENT_FOR_MONTH'
  | 'AMBIGUOUS_CONTENT'
  | 'MISSING_START_GUIDE'
  | 'INVALID_NAME'
  | 'INVALID_EMAIL'
  | 'STAMP_TOO_LONG'
  | 'INVALID_ORDER_CODE'
  | 'INVALID_SOURCE_KEY'
  | 'SOURCE_NOT_FOUND';

/**
 * Validation or missing-content error of the base service. `code` is stable and
 * meant for machines; `message` is user-facing Spanish text.
 */
export class BaseServiceError extends Error {
  constructor(
    readonly code: BaseServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BaseServiceError';
  }
}
