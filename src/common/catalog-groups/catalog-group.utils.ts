import { BadRequestException } from '@nestjs/common';

export function normalizeGroupName(name: string) {
  const displayName = name.trim().replace(/\s+/g, ' ');

  if (!displayName || displayName.length > 100) {
    throw new BadRequestException(
      'El nombre del grupo debe tener entre 1 y 100 caracteres',
    );
  }

  return {
    name: displayName,
    normalizedName: displayName
      .toLocaleLowerCase('es-ES')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC'),
  };
}
