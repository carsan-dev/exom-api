import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

type PasswordEmailKind = 'invitation' | 'password-reset';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resendApiKey?: string;
  private readonly resendFromEmail?: string;
  private readonly firebaseWebApiKey?: string;
  private readonly logoUrl?: string;

  constructor(private readonly config: ConfigService) {
    this.resendApiKey = this.config.get<string>('RESEND_API_KEY');
    this.resendFromEmail = this.config.get<string>('RESEND_FROM_EMAIL');
    this.firebaseWebApiKey = this.config.get<string>('FIREBASE_WEB_API_KEY');
    this.logoUrl = this.config.get<string>('EMAIL_LOGO_URL');
  }

  async sendPasswordActionEmail(email: string, kind: PasswordEmailKind) {
    const normalizedEmail = email.trim().toLowerCase();

    if (!this.resendApiKey || !this.resendFromEmail) {
      await this.sendFirebaseTemplateEmail(normalizedEmail);
      return;
    }

    const actionLink =
      await admin.auth().generatePasswordResetLink(normalizedEmail);
    await this.sendResendEmail(normalizedEmail, actionLink, kind);
  }

  private async sendFirebaseTemplateEmail(email: string) {
    if (!this.firebaseWebApiKey) {
      this.logger.warn('FIREBASE_WEB_API_KEY is not configured');
      return;
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseWebApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Firebase password email failed: ${response.status} ${body}`,
      );
      throw new InternalServerErrorException(
        'No se pudo enviar el email de recuperaci\u00f3n.',
      );
    }
  }

  private async sendResendEmail(
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

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.resendFromEmail,
        to: email,
        subject,
        html: this.buildPasswordActionHtml(actionLink, kind, preheader),
        text: [
          subject,
          preheader,
          `Enlace: ${actionLink}`,
          'Si no has sido t\u00fa, puedes ignorar este correo.',
        ].join('\n\n'),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Resend email failed: ${response.status} ${body}`);
      throw new InternalServerErrorException(
        'No se pudo enviar el email de recuperaci\u00f3n.',
      );
    }
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
