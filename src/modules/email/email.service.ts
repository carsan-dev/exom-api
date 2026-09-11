import { randomUUID } from 'node:crypto';
import { DurableWork, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { withLiveUsers } from '../../common/user-external-effect';
import {
  enqueueWork,
  JobsService,
  PermanentWorkError,
} from '../jobs/jobs.service';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

type PasswordEmailKind = 'invitation' | 'password-reset';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private readonly resendApiKey?: string;
  private readonly resendFromEmail?: string;
  private readonly firebaseWebApiKey?: string;
  private readonly logoUrl?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {
    this.resendApiKey = this.config.get<string>('RESEND_API_KEY');
    this.resendFromEmail = this.config.get<string>('RESEND_FROM_EMAIL');
    this.firebaseWebApiKey = this.config.get<string>('FIREBASE_WEB_API_KEY');
    this.logoUrl = this.config.get<string>('EMAIL_LOGO_URL');
  }

  onModuleInit() {
    this.jobs.register('EMAIL', (work) => this.deliver(work));
  }

  async sendPasswordActionEmail(email: string, kind: PasswordEmailKind) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!user) return; // Password-reset responses do not enumerate accounts.
    await enqueueWork(
      this.prisma,
      'email:' + randomUUID(),
      'EMAIL',
      { kind },
      user.id,
    );
  }

  async deliver(work: DurableWork) {
    const payload = work.payload;
    if (
      !work.owner_id ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      (payload.kind !== 'invitation' && payload.kind !== 'password-reset')
    )
      throw new PermanentWorkError('INVALID_EMAIL_INTENT');
    if (payload.accepted === true) return;
    if (!work.claim_token) throw new PermanentWorkError('CLAIM_REQUIRED');
    const claim = {
      key: work.key,
      claim_token: work.claim_token,
      status: 'RUNNING',
    };
    const kind =
      payload.kind === 'invitation' ? 'invitation' : 'password-reset';
    await withLiveUsers(this.prisma, [work.owner_id], async () => {
      if (
        !(await this.prisma.durableWork.findFirst({
          where: claim,
          select: { key: true },
        }))
      )
        throw new PermanentWorkError('CLAIM_LOST');
      const user = await this.prisma.user.findUnique({
        where: { id: work.owner_id! },
        select: { email: true, is_active: true },
      });
      if (!user?.is_active)
        throw new PermanentWorkError('RECIPIENT_UNAVAILABLE');
      if (
        typeof payload.recipientEmail === 'string' &&
        payload.recipientEmail !== user.email
      )
        throw new PermanentWorkError('EMAIL_RECIPIENT_CHANGED');
      if (
        payload.channel === 'FIREBASE_EMAIL' ||
        (payload.channel !== 'RESEND' &&
          (!this.resendApiKey || !this.resendFromEmail))
      ) {
        await this.prisma.durableWork.update({
          where: claim,
          data: {
            payload: {
              kind,
              channel: 'FIREBASE_EMAIL',
              recipientEmail: user.email,
            },
          },
        });
        await this.sendFirebaseTemplateEmail(user.email);
        await this.prisma.durableWork.update({
          where: claim,
          data: {
            payload: {
              kind,
              channel: 'FIREBASE_EMAIL',
              accepted: true,
              acceptedAt: new Date().toISOString(),
            },
          },
        });
        return;
      }
      if (!this.resendApiKey || !this.resendFromEmail)
        throw new PermanentWorkError('EMAIL_PROVIDER_NOT_CONFIGURED');
      let request: Prisma.InputJsonObject;
      let preparedAt: string;
      if (
        payload.request &&
        typeof payload.request === 'object' &&
        !Array.isArray(payload.request)
      ) {
        const saved = payload.request;
        if (
          typeof saved.to !== 'string' ||
          typeof saved.from !== 'string' ||
          typeof saved.subject !== 'string' ||
          typeof saved.html !== 'string' ||
          typeof saved.text !== 'string' ||
          typeof payload.preparedAt !== 'string'
        )
          throw new PermanentWorkError('INVALID_EMAIL_REQUEST');
        if (saved.to !== user.email)
          throw new PermanentWorkError('EMAIL_RECIPIENT_CHANGED');
        if (Date.now() - Date.parse(payload.preparedAt) >= 23 * 3600000)
          throw new PermanentWorkError('EMAIL_DEDUP_WINDOW_EXPIRED');
        request = {
          from: saved.from,
          to: saved.to,
          subject: saved.subject,
          html: saved.html,
          text: saved.text,
        };
        preparedAt = payload.preparedAt;
      } else {
        const actionLink = await admin
          .auth()
          .generatePasswordResetLink(user.email);
        request = this.buildResendRequest(user.email, actionLink, kind);
        preparedAt = new Date().toISOString();
        // Persist the exact payload before the provider call so retries use the
        // same Resend idempotency key AND body. Never expose this private link.
        await this.prisma.durableWork.update({
          where: claim,
          data: { payload: { kind, channel: 'RESEND', request, preparedAt } },
        });
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: 'Bearer ' + this.resendApiKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': work.key,
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error('EMAIL_PROVIDER_REJECTED');
      const receipt: unknown = await response.json();
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        !('id' in receipt) ||
        typeof receipt.id !== 'string' ||
        !receipt.id
      )
        throw new Error('EMAIL_ACCEPTANCE_MISSING');
      await this.prisma.durableWork.update({
        where: claim,
        data: {
          payload: {
            kind,
            channel: 'RESEND',
            accepted: true,
            providerMessageId: receipt.id,
            acceptedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  private async sendFirebaseTemplateEmail(email: string) {
    if (!this.firebaseWebApiKey) {
      throw new PermanentWorkError('EMAIL_PROVIDER_NOT_CONFIGURED');
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseWebApiKey}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email,
        }),
      },
    );

    if (!response.ok) {
      // Do not log the provider body (it may contain an email or action link).
      throw new InternalServerErrorException(
        'No se pudo enviar el email de recuperaci\u00f3n.',
      );
    }
    const receipt: unknown = await response.json();
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      !('email' in receipt) ||
      receipt.email !== email
    )
      throw new Error('EMAIL_ACCEPTANCE_MISSING');
  }

  private buildResendRequest(
    email: string,
    actionLink: string,
    kind: PasswordEmailKind,
  ) {
    const isInvitation = kind === 'invitation';
    const subject = isInvitation
      ? 'Activa tu cuenta de EXOM'
      : 'Restablece tu contrase\u00f1a de EXOM';
    const preheader = isInvitation
      ? 'Configura tu contrase\u00f1a para acceder a EXOM.'
      : 'Usa este enlace para recuperar el acceso a tu cuenta.';

    return {
      from: this.resendFromEmail!,
      to: email,
      subject,
      html: this.buildPasswordActionHtml(actionLink, kind, preheader),
      text: [
        subject,
        preheader,
        'Enlace: ' + actionLink,
        'Si no has sido tú, puedes ignorar este correo.',
      ].join('\n\n'),
    };
  }

  private buildPasswordActionHtml(
    actionLink: string,
    kind: PasswordEmailKind,
    preheader: string,
  ) {
    const isInvitation = kind === 'invitation';
    const title = isInvitation
      ? 'Bienvenido a EXOM'
      : 'Restablece tu contrase&ntilde;a';
    const body = isInvitation
      ? 'Tu cuenta ya est&aacute; preparada. Define tu contrase&ntilde;a para entrar en la aplicaci&oacute;n.'
      : 'Hemos recibido una solicitud para restablecer la contrase&ntilde;a de tu cuenta.';
    const cta = isInvitation
      ? 'Activar cuenta'
      : 'Restablecer contrase&ntilde;a';

    return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background:#f4f0eb; font-family:Inter, Arial, sans-serif; color:#221c17;">
    <div style="display:none; overflow:hidden; line-height:1px; opacity:0; max-height:0; max-width:0;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f0eb; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; background:#fffaf5; border:1px solid #e5d8cc; border-radius:24px; overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 16px; text-align:center;">
                ${this.logoMarkup()}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 8px; text-align:center;">
                <p style="margin:0 0 10px; color:#8b5e3c; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase;">EXOM Method</p>
                <h1 style="margin:0; font-size:30px; line-height:1.15; color:#221c17;">${title}</h1>
                <p style="margin:18px 0 0; font-size:16px; line-height:1.6; color:#5b5148;">${body}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 40px 12px;">
                <a href="${actionLink}" style="display:inline-block; background:#221c17; color:#ffffff; text-decoration:none; padding:14px 22px; border-radius:999px; font-size:15px; font-weight:700;">${cta}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 32px; text-align:center;">
                <p style="margin:0; color:#7a6c60; font-size:13px; line-height:1.6;">Este enlace caduca por seguridad. Si no has sido t&uacute;, puedes ignorar este correo.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private logoMarkup() {
    if (this.logoUrl) {
      return `<img src="${this.logoUrl}" width="112" alt="EXOM" style="display:block; margin:0 auto; max-width:112px; height:auto;">`;
    }

    return '<div style="font-size:28px; font-weight:800; letter-spacing:0.18em; color:#221c17;">EXOM</div>';
  }
}
