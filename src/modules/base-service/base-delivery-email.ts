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

  const month = escapeHtml(String(input.month));
  // Tokens from the live site (exom-site/REDESIGN/prototype-v4/styles.css
  // :root): dark base, panel, bone ink, muted text, lime accent, rules. Fonts:
  // condensed Barlow 800 for headings and the wordmark, DM Sans for text;
  // both fall back to system fonts because email clients ignore web fonts.
  const c = {
    bg: '#101111',
    panel: '#191b19',
    ink: '#f2f1e9',
    muted: '#b7bcb3',
    lime: '#baf23a',
    rule: '#363b32',
  };
  const display = `'Barlow Condensed', Barlow, 'Arial Narrow', Arial, sans-serif`;
  const sans = `'DM Sans', DM, Arial, Helvetica, sans-serif`;

  // Site lockup: lime symbol (only when a public logo URL is configured,
  // exommethod.com/email-logo.png) plus the text wordmark E<lime X>OM.
  const symbol = input.logoUrl
    ? `<td style="padding:0 10px 0 0; vertical-align:middle;"><img src="${escapeHtml(input.logoUrl)}" width="44" height="44" alt="" style="display:block; width:44px; height:44px; border:0;"></td>`
    : '';
  const wordmark = `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${symbol}<td style="vertical-align:middle; font-family:${display}; font-size:36px; line-height:1; font-weight:800; letter-spacing:-0.04em; color:${c.ink};">E<span style="color:${c.lime};">X</span>OM</td></tr></table>`;
  const rows = items
    .map(
      (item) =>
        `<tr><td style="padding:14px 0; border-top:1px solid ${c.rule}; font-family:${sans};"><span style="display:block; font-size:16px; line-height:1.5; font-weight:600; color:${c.ink};">${escapeHtml(item.label)}</span><span style="display:block; font-size:14px; line-height:1.5; color:${c.muted}; word-break:break-all;">${escapeHtml(item.filename)}</span></td></tr>`,
    )
    .join('');
  const helpHtml = input.supportUrl
    ? `Si tienes cualquier duda o no puedes abrir alg&uacute;n archivo, responde a este correo o escr&iacute;benos desde <a href="${escapeHtml(input.supportUrl)}" style="color:${c.lime}; text-decoration:underline; word-break:break-all;">${escapeHtml(input.supportUrl)}</a>.`
    : 'Si tienes cualquier duda o no puedes abrir alg&uacute;n archivo, responde a este correo.';
  const supportButton = input.supportUrl
    ? `
            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${c.lime}" style="background:${c.lime};"><a href="${escapeHtml(input.supportUrl)}" style="display:block; padding:16px 24px; font-family:${sans}; font-size:16px; line-height:24px; font-weight:600; color:${c.bg}; text-decoration:none; text-align:center;">Abrir la ayuda</a></td></tr></table>
              </td>
            </tr>`
    : '';
  const text16 = `font-family:${sans}; font-size:16px; line-height:1.65;`;

  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body bgcolor="${c.bg}" style="margin:0; padding:0; background:${c.bg}; color:${c.ink}; font-family:${sans}; -webkit-text-size-adjust:100%;">
    <div style="display:none; overflow:hidden; line-height:1px; opacity:0; max-height:0; max-width:0; mso-hide:all;">Tu material del mes ${month} va adjunto.${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${c.bg}" style="background:${c.bg};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="${c.panel}" style="width:100%; max-width:600px; background:${c.panel}; border:1px solid ${c.rule};">
            <tr>
              <td style="padding:28px 28px 24px; border-bottom:1px solid ${c.rule};">
                ${wordmark}
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px;">
                <p style="margin:0 0 16px; font-family:${sans}; font-size:12px; line-height:1.4; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:${c.lime};">EXOM Method</p>
                <h1 style="margin:0; font-family:${display}; font-size:40px; line-height:1; font-weight:800; letter-spacing:-0.02em; text-transform:uppercase; color:${c.ink};">Tu material del <span style="color:${c.lime};">mes ${month}</span></h1>
                <p style="margin:24px 0 0; ${text16} color:${c.ink};">Hola ${escapeHtml(firstName)}:</p>
                <p style="margin:12px 0 0; ${text16} color:${c.ink};">Te enviamos tu material del mes ${month} de EXOM. Lo encontrar&aacute;s adjunto en este correo:</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-bottom:1px solid ${c.rule};">${rows}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px 24px;">
                <p style="margin:0 0 16px; ${text16} color:${c.muted};">Estos archivos son para tu uso personal: llevan tu nombre, tu email y tu n&uacute;mero de pedido. Por favor, no los compartas.</p>
                <p style="margin:0; ${text16} color:${c.muted};">${helpHtml}</p>
              </td>
            </tr>${supportButton}
            <tr>
              <td style="padding:24px 28px 32px;">
                <p style="margin:0; ${text16} color:${c.ink};">Un saludo,<br>El equipo de EXOM</p>
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
