import { buildBaseDeliveryEmail } from './base-delivery-email';

const MONTH_1 = [
  {
    filename: 'EXOM_Entrenamiento_Perder-grasa_3-dias_Bloque-01.pdf',
    source_key:
      'entrenamiento/perder-grasa/EXOM_Entrenamiento_Perder-grasa_3-dias_Bloque-01.pdf',
  },
  {
    filename: 'EXOM_Nutricion_Perder-grasa_Guia-01.pdf',
    source_key:
      'nutricion/perder-grasa/EXOM_Nutricion_Perder-grasa_Guia-01.pdf',
  },
  {
    filename: 'EXOM_Nutricion_Guia-de-inicio.pdf',
    source_key: 'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf',
  },
];

describe('buildBaseDeliveryEmail', () => {
  it('uses the agreed subject and greets by first name', () => {
    const email = buildBaseDeliveryEmail({
      name: 'Ana María Pérez',
      month: 1,
      daysPerWeek: 3,
      files: MONTH_1,
    });
    expect(email.subject).toBe('EXOM · Tu material del mes 1');
    expect(email.text.startsWith('Hola Ana:')).toBe(true);
    expect(email.html).toContain('Hola Ana:');
  });

  it('lists month 1 files in human terms, including the start guide', () => {
    const { text, html } = buildBaseDeliveryEmail({
      name: 'Ana',
      month: 1,
      daysPerWeek: 3,
      files: MONTH_1,
    });
    for (const label of [
      'Bloque de entrenamiento del mes 1 (3 días por semana)',
      'Guía de nutrición del mes 1',
      'Guía de inicio',
    ]) {
      expect(text).toContain(label);
    }
    expect(html).toContain('Guía de inicio');
    expect(text).toContain('uso personal');
    expect(text).toContain('responde a este correo');
  });

  it('does not mention a start guide after month 1', () => {
    const { text } = buildBaseDeliveryEmail({
      name: 'Ana',
      month: 2,
      daysPerWeek: 4,
      files: MONTH_1.slice(0, 2),
    });
    expect(text).not.toContain('Guía de inicio');
    expect(text).toContain('material del mes 2');
  });

  it('escapes the name in HTML and adds the support URL when configured', () => {
    const { html, text } = buildBaseDeliveryEmail({
      name: '<b>Eva</b> Ruiz',
      month: 1,
      daysPerWeek: 3,
      files: MONTH_1,
      supportUrl: 'https://exommethod.com/support',
    });
    expect(html).not.toContain('<b>Eva</b>');
    expect(html).toContain('&lt;b&gt;Eva&lt;/b&gt;');
    expect(text).toContain('https://exommethod.com/support');
  });

  it('escapes every interpolated value (name, file names, support and logo URLs)', () => {
    const hostile = {
      name: `<img/src=x/onerror=alert(1)>"Eva"&'R' Ruiz`,
      filename: `Bloque<script>alert(2)</script>&"q'.pdf`,
      supportUrl: `https://exommethod.com/support/?a=1&b="x"><svg onload=alert(3)>`,
      logoUrl: `https://www.exommethod.com/email-logo.png?v=1&x="><svg onload=alert(4)>`,
    };
    const { html, text } = buildBaseDeliveryEmail({
      name: hostile.name,
      month: 1,
      daysPerWeek: 3,
      files: [
        { ...MONTH_1[0], filename: hostile.filename },
        ...MONTH_1.slice(1),
      ],
      supportUrl: hostile.supportUrl,
      logoUrl: hostile.logoUrl,
    });
    for (const raw of [
      '<img/src',
      '<script>',
      '<svg',
      '"Eva"',
      `&'R'`,
      '&"q',
      'a=1&b=',
      'v=1&x=',
    ]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain(
      '&lt;img/src=x/onerror=alert(1)&gt;&quot;Eva&quot;&amp;&#39;R&#39;',
    );
    expect(html).toContain(
      'Bloque&lt;script&gt;alert(2)&lt;/script&gt;&amp;&quot;q&#39;.pdf',
    );
    expect(html).toContain(
      'href="https://exommethod.com/support/?a=1&amp;b=&quot;x&quot;&gt;&lt;svg onload=alert(3)&gt;"',
    );
    expect(html).toContain(
      'src="https://www.exommethod.com/email-logo.png?v=1&amp;x=&quot;&gt;&lt;svg onload=alert(4)&gt;"',
    );
    // The plain-text part is not HTML: values stay verbatim there.
    expect(text).toContain(hostile.filename);
    expect(text).toContain(hostile.supportUrl);
  });

  it('starts the body with a hidden preheader naming the month', () => {
    const { html } = buildBaseDeliveryEmail({
      name: 'Ana',
      month: 2,
      daysPerWeek: 4,
      files: MONTH_1.slice(0, 2),
    });
    const body = html.slice(html.indexOf('<body'));
    const preheader = /^<body[^>]*>\s*<div([^>]*)>([^<]*)<\/div>/.exec(body);
    expect(preheader).not.toBeNull();
    expect(preheader?.[1]).toContain('display:none');
    expect(preheader?.[1]).toContain('max-height:0');
    expect(preheader?.[2]).toContain('Tu material del mes 2 va adjunto.');
  });

  it('follows the exommethod.com brand and email-client constraints', () => {
    const { html } = buildBaseDeliveryEmail({
      name: 'Ana',
      month: 1,
      daysPerWeek: 3,
      files: MONTH_1,
      supportUrl: 'https://exommethod.com/support/',
    });
    // Site tokens (REDESIGN/prototype-v4/styles.css :root).
    for (const token of ['#101111', '#191b19', '#f2f1e9', '#b7bcb3', '#baf23a'])
      expect(html).toContain(token);
    expect(html).toContain('bgcolor="#101111"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(
      '<meta name="supported-color-schemes" content="light dark">',
    );
    // Inline styles only: no <style>, <link> or <script> blocks.
    expect(html).not.toMatch(/<style\b|<link\b|<script\b/i);
    expect(html).toContain('max-width:600px');
    // Wordmark rendered as text, as on the site: E<lime X>OM.
    expect(html).toMatch(/>E<span[^>]*color:#baf23a[^>]*>X<\/span>OM</);
    // Support link: a block-level button with a large tap target.
    expect(html).toMatch(
      /<a href="https:\/\/exommethod\.com\/support\/"[^>]*display:block[^>]*>/,
    );
    // Body copy at 16 px or more.
    expect(html).not.toMatch(
      /font-size:1[0-5]px[^"]*"[^>]*>(Hola|Estos archivos|Si tienes)/,
    );
  });

  it('keeps the text and HTML parts in sync', () => {
    const { html, text } = buildBaseDeliveryEmail({
      name: 'Ana María',
      month: 1,
      daysPerWeek: 3,
      files: MONTH_1,
      supportUrl: 'https://exommethod.com/support/',
    });
    const decoded = html
      .replace(/<[^>]+>/g, '')
      .replaceAll('&aacute;', 'á')
      .replaceAll('&iacute;', 'í')
      .replaceAll('&uacute;', 'ú')
      .replace(/\s+/g, ' ');
    for (const line of text.split('\n').filter(Boolean)) {
      expect(decoded).toContain(
        line.replace(/^- /, '').replace(/ \(.*\)$/, ''),
      );
    }
  });
});
