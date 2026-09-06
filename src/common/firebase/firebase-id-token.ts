import { Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

type FirebaseLookupUser = {
  localId?: string;
  email?: string;
};

type FirebaseLookupResponse = {
  users?: FirebaseLookupUser[];
  error?: { message?: string };
};

export type VerifiedFirebaseIdToken = Pick<
  admin.auth.DecodedIdToken,
  'uid' | 'email'
> & {
  firebase?: { sign_in_provider?: string };
};

export class FirebaseIdTokenRejectedError extends Error {
  constructor() {
    super('Firebase rejected the ID token');
    this.name = 'FirebaseIdTokenRejectedError';
  }
}

const rejectedIdTokenCodes = new Set([
  'auth/argument-error',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/tenant-id-mismatch',
  'auth/user-disabled',
]);

const rejectedRestTokenCodes = new Set([
  'CREDENTIAL_TOO_OLD_LOGIN_AGAIN',
  'INVALID_ID_TOKEN',
  'TOKEN_EXPIRED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
]);

export function isFirebaseIdTokenRejectedError(error: unknown): boolean {
  if (error instanceof FirebaseIdTokenRejectedError) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && rejectedIdTokenCodes.has(code);
}

function cleanEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

async function lookupFirebaseIdToken(
  token: string,
  webApiKey: string | undefined,
  logger: Logger,
  logContext: string,
): Promise<VerifiedFirebaseIdToken> {
  const apiKey = cleanEnvValue(webApiKey);
  if (!apiKey) {
    throw new Error('FIREBASE_WEB_API_KEY is not configured');
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    },
  );

  const payload = (await response
    .json()
    .catch(() => null)) as FirebaseLookupResponse | null;
  const user = payload?.users?.[0];

  if (!response.ok || !user?.localId) {
    const reason =
      payload?.error?.message ??
      `HTTP ${response.status} ${response.statusText}`;
    logger.error(`${logContext}: Firebase REST token lookup failed: ${reason}`);
    const restCode = reason.split(':', 1)[0]?.trim();
    if (restCode && rejectedRestTokenCodes.has(restCode)) {
      throw new FirebaseIdTokenRejectedError();
    }
    throw new Error('Firebase REST token lookup failed');
  }

  return {
    uid: user.localId,
    email: user.email,
  };
}

export async function verifyFirebaseIdTokenWithFallback({
  token,
  webApiKey,
  restFallbackEnabled = false,
  logger,
  logContext,
  expectedProvider,
}: {
  token: string;
  webApiKey?: string;
  restFallbackEnabled?: boolean;
  logger: Logger;
  logContext: string;
  expectedProvider?: string;
}): Promise<VerifiedFirebaseIdToken> {
  let adminVerificationError: unknown;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (error) {
    adminVerificationError = error;
    logger.error(
      `${logContext}: Firebase Admin token verification failed: ${errorMessage(error)}`,
    );

    if (!restFallbackEnabled || isFirebaseIdTokenRejectedError(error)) {
      throw error;
    }
  }

  // accounts:lookup proves token ownership, but it does not expose the
  // sign_in_provider claim of this concrete token. Never use it where the
  // provider itself is part of the authorization decision.
  if (expectedProvider) {
    logger.warn(
      `${logContext}: Firebase REST token fallback skipped for provider-sensitive verification`,
    );
    throw adminVerificationError;
  }

  logger.warn(
    `${logContext}: using explicitly enabled Firebase REST token fallback`,
  );
  return lookupFirebaseIdToken(token, webApiKey, logger, logContext);
}
