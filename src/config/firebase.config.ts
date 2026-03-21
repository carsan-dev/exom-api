import * as admin from 'firebase-admin';
import { Logger } from '@nestjs/common';

const logger = new Logger('FirebaseConfig');

export function initFirebase(): void {
  if (admin.apps.length > 0) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId) {
    logger.warn('FIREBASE_PROJECT_ID not set — Firebase Auth disabled');
    return;
  }

  if (privateKey && clientEmail) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, privateKey, clientEmail }),
    });
  } else {
    // Application Default Credentials (for local dev with emulator or GCP)
    admin.initializeApp({ projectId });
  }

  logger.log(`Firebase initialized for project: ${projectId}`);
}
