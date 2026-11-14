import { Injectable } from '@nestjs/common';
import { stampPdf, StampOptions } from './base-pdf-stamp';

/**
 * The stamping step used by delivery requests, resends and the worker. A
 * provider (not a direct call) so tests can substitute a stamper whose output
 * differs, as a PDF-library or font upgrade would.
 */
@Injectable()
export class BasePdfStamper {
  stamp(source: Uint8Array, options: StampOptions): Promise<Uint8Array> {
    return stampPdf(source, options);
  }
}
