import { Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

type FirebaseLookupUser = {
  localId?: string;
  email?: string;
  providerUserInfo?: Array<{ providerId?: string }>;
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
  expectedProvider?: string,
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

  const payload = (await response.json().catch(() => null)) as
    | FirebaseLookupResponse
    | null;
  const user = payload?.users?.[0];

  if (!response.ok || !user?.localId) {
    const reason =
      payload?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
    logger.error(`${logContext}: Firebase REST token lookup failed: ${reason}`);
    throw new Error('Firebase REST token lookup failed');
  }

  let signInProvider = user.providerUserInfo?.[0]?.providerId;
  if (expectedProvider) {
    const providerMatches =
      user.providerUserInfo?.some(
        (provider) => provider.providerId === expectedProvider,
      ) ?? false;
    signInProvider = providerMatches ? expectedProvider : signInProvider;
  }

  return {
    uid: user.localId,
    email: user.email,
    firebase: signInProvider
      ? { sign_in_provider: signInProvider }
      : undefined,
  };
}

export async function verifyFirebaseIdTokenWithFallback({
  token,
  webApiKey,
  logger,
  logContext,
  expectedProvider,
}: {
  token: string;
  webApiKey?: string;
  logger: Logger;
  logContext: string;
  expectedProvider?: string;
}): Promise<VerifiedFirebaseIdToken> {
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (error) {
    logger.error(
      `${logContext}: Firebase Admin token verification failed: ${errorMessage(error)}`,
    );
  }

  return lookupFirebaseIdToken(
    token,
    webApiKey,
    logger,
    logContext,
    expectedProvider,
  );
}
