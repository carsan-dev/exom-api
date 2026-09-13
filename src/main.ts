import 'dotenv/config';
import { bootstrap } from './bootstrap';
import { startupError } from './startup-error';

bootstrap().catch((error: unknown) => {
  console.error(startupError('dependencies', error).message);
  process.exitCode = 1;
});
