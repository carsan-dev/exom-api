import { START_GUIDE_KEY } from './base-package-selection';

export interface BaseDeliveryEmailInput {
  /** Snapshot name, already normalised (single spaces). */
  name: string;
  month: number;
  daysPerWeek: number;
  files: readonly { filename: string; source_key: string }[];
  logoUrl?: string;
  supportUrl?: string;
}

export interface BaseDeliveryEmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Human description of one attached file, from its catalogue key. */
export function describeDeliveryFile(
  sourceKey: string,
  month: number,
  daysPerWeek: number,
): string {
  if (sourceKey === START_GUIDE_KEY) return 'Guía de inicio';
  if (sourceKey.startsWith('entrenamiento/'))
    return `Bloque de entrenamiento del mes ${month} (${daysPerWeek} días por semana)`;
  if (sourceKey.startsWith('nutricion/'))
    return `Guía de nutrición del mes ${month}`;
  return 'Material del mes';
}

export function buildBaseDeliveryEmail(
  input: BaseDeliveryEmailInput,
): BaseDeliveryEmailContent {
  const firstName = input.name.split(' ')[0] || input.name;
  const subject = `EXOM · Tu material del mes ${input.month}`;
  const items = input.files.map((file) => ({
    label: describeDeliveryFile(
      file.source_key,
      input.month,
      input.daysPerWeek,
    ),
    filename: file.filename,
  }));
  const help = input.supportUrl
    ? `Si tienes cualquier duda o no puedes abrir algún archivo, responde a este correo o escríbenos desde ${input.supportUrl}.`
    : 'Si tienes cualquier duda o no puedes abrir algún archivo, responde a este correo.';
  const personal =
    'Estos archivos son para tu uso personal: llevan tu nombre, tu email y tu número de pedido. Por favor, no los compartas.';
  const intro = `Te enviamos tu material del mes ${input.month} de EXOM. Lo encontrarás adjunto en este correo:`;

  const text = [
    `Hola ${firstName}:`,
    intro,
    items.map((item) => `- ${item.label} (${item.filename})`).join('\n'),
    personal,
    help,
    'Un saludo,\nEl equipo de EXOM',
  ].join('\n\n');

  const logo = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" width="112" alt="EXOM" style="display:block; margin:0 auto; max-width:112px; height:auto;">`
    : '<div style="font-size:28px; font-weight:800; letter-spacing:0.18em; color:#221c17;">EXOM</div>';
  const list = items
    .map(
      (item) =>
        `<li style="margin:0 0 8px;"><strong>${escapeHtml(item.label)}</strong><br><span style="color:#7a6c60; font-size:13px;">${escapeHtml(item.filename)}</span></li>`,
    )
    .join('');
  const helpHtml = input.supportUrl
    ? `Si tienes cualquier duda o no puedes abrir alg&uacute;n archivo, responde a este correo o escr&iacute;benos desde <a href="${escapeHtml(input.supportUrl)}" style="color:#8b5e3c;">${escapeHtml(input.supportUrl)}</a>.`
    : 'Si tienes cualquier duda o no puedes abrir alg&uacute;n archivo, responde a este correo.';

  // Same card layout and palette as the account emails in EmailService.
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background:#f4f0eb; font-family:Inter, Arial, sans-serif; color:#221c17;">
    <div style="display:none; overflow:hidden; line-height:1px; opacity:0; max-height:0; max-width:0;">Tu material del mes ${input.month} va adjunto.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f0eb; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; background:#fffaf5; border:1px solid #e5d8cc; border-radius:24px; overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 16px; text-align:center;">
                ${logo}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 8px; text-align:center;">
                <p style="margin:0 0 10px; color:#8b5e3c; font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase;">EXOM Method</p>
                <h1 style="margin:0; font-size:30px; line-height:1.15; color:#221c17;">Tu material del mes ${input.month}</h1>
                <p style="margin:18px 0 0; font-size:16px; line-height:1.6; color:#5b5148;">Hola ${escapeHtml(firstName)}: te enviamos tu material del mes ${input.month} de EXOM. Lo encontrar&aacute;s adjunto en este correo.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px 4px;">
                <ul style="margin:0; padding:0 0 0 20px; font-size:15px; line-height:1.5; color:#221c17;">${list}</ul>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 40px 32px; text-align:center;">
                <p style="margin:0 0 12px; color:#7a6c60; font-size:13px; line-height:1.6;">Estos archivos son para tu uso personal: llevan tu nombre, tu email y tu n&uacute;mero de pedido. Por favor, no los compartas.</p>
                <p style="margin:0; color:#7a6c60; font-size:13px; line-height:1.6;">${helpHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
