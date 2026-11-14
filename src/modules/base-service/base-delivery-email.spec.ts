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
});
