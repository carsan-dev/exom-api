const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../prisma/schema.prisma');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'exom-schema-'));
const copy = path.join(directory, 'schema.prisma');
const before = fs.readFileSync(source, 'utf8');
try {
  fs.writeFileSync(copy, before);
  const child = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'format', '--schema', copy], { encoding: 'utf8', windowsHide: true });
  if (child.status !== 0) throw Error('Prisma formatter failed: ' + child.stderr);
  const formatted = fs.readFileSync(copy, 'utf8');
  const tokens = s => s.split('\n}').map(block => {
    const attributes = [];
    const body = block.replace(/^\s*@@[^\r\n]+/gm, line => { attributes.push(line.trim()); return ''; });
    return body + attributes.sort().join('\n');
  }).join('\n}').replace(/\/\/[^\n]*|"(?:\\.|[^"\\])*"|\s+/g, match => match.startsWith('"') ? match : '');
  if (tokens(before) !== tokens(formatted)) throw Error('Formatting changed schema tokens; inspect before writing');
  if (process.argv.includes('--write')) {
    fs.writeFileSync(source, formatted);
    console.log('Schema formatted; non-comment schema tokens unchanged');
  } else if (before.replaceAll('\r\n','\n') !== formatted.replaceAll('\r\n','\n')) {
    throw Error('Schema is not formatted; run node scripts/check-prisma-format.cjs --write and review the diff');
  } else console.log('Prisma schema format PASS; source unchanged');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (fs.existsSync(copy)) fs.unlinkSync(copy);
  fs.rmdirSync(directory);
}
