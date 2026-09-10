import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';

export function identityErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || !error || !('code' in error)) return;
  return typeof error.code === 'string' ? error.code : undefined;
}

@Injectable()
export class IdentityProvider {
  async get(uid: string) {
    try {
      return await admin.auth().getUser(uid);
    } catch (error: unknown) {
      if (identityErrorCode(error) === 'auth/user-not-found') return null;
      throw error;
    }
  }

  create(input: admin.auth.CreateRequest) {
    return admin.auth().createUser(input);
  }

  update(uid: string, input: admin.auth.UpdateRequest) {
    return admin.auth().updateUser(uid, input);
  }

  revoke(uid: string) {
    return admin.auth().revokeRefreshTokens(uid);
  }

  async remove(uid: string) {
    try {
      await admin.auth().deleteUser(uid);
    } catch (error: unknown) {
      if (identityErrorCode(error) !== 'auth/user-not-found') throw error;
    }
    if (await this.get(uid)) throw new Error('IDENTITY_STILL_EXISTS');
  }
}
