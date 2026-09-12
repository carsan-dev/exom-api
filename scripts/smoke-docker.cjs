const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { databaseUrl, verifyDatabase } = require('./test-database.cjs');
const image = process.argv[2];
const name = `exom-ci-smoke-${process.pid}`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function probe(path, port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/v1/health/${path}`, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
      response.on('error', reject);
    });
    request.setTimeout(1000, () => request.destroy(Error('Probe timeout')));
    request.on('error', reject);
  });
}
async function main() {
  if (!image || !/^[a-zA-Z0-9:./_-]+$/.test(image)) throw Error('Reviewed image required');
  await verifyDatabase();
  const config = JSON.parse(docker(['image','inspect',image]))[0].Config;
  assert.equal(config.User, 'node');
  assert.deepEqual(config.Cmd, ['node', 'dist/src/main.js']);
  assert.ok(config.Env.includes('NODE_ENV=production'));
  const url = new URL(databaseUrl());
  const linux = process.platform === 'linux';
  if (!linux) url.hostname = 'host.docker.internal';
  const port = '33009';
  const network = linux ? ['--network','host'] : ['--publish',`127.0.0.1:${port}:${port}`];
  const ca = process.env.SMOKE_DATABASE_SSL_CA;
  const environment = ca ? ['--env','NODE_ENV=production','--env','DATABASE_SSL_MODE=verify-full',
    '--env',`DATABASE_SSL_CA=${ca}`] : ['--env','NODE_ENV=test','--env','DATABASE_SSL_MODE=disable'];
  let created = false;
  try {
    docker(['create','--name',name,'--label','exom.scope=ci-smoke',...network,
      ...environment,'--env',`DATABASE_URL=${url}`,
      '--env',`PORT=${port}`,image]);
    created = true;
    docker(['start',name]);
    let ready = false;
    for (let attempt=0;attempt<60;attempt++) {
      try { ready = (await probe('ready', port)) === 200; } catch {}
      if (ready) break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(ready, 'Runner did not become ready');
    assert.equal(await probe('live', port),200);
    docker(['exec',name,'node','-e',`const fs=require('fs');if(process.getuid()===0)throw Error('root');for(const p of ['src','test','node_modules/typescript','node_modules/jest','node_modules/@nestjs/cli','node_modules/prisma'])if(fs.existsSync(p))throw Error('Unexpected build dependency: '+p);require('dotenv/config');require('@prisma/client');`]);
    docker(['stop','--time','20',name]);
    const state = JSON.parse(docker(['inspect',name]))[0].State;
    assert.equal(state.ExitCode,0, 'SIGTERM must close normally, not time out');
    console.log('Docker runner PASS: output path, non-root, production dependencies, HTTP probes, graceful SIGTERM');
  } finally {
    if (created) {
      docker(['stop','--time','20',name]);
      docker(['rm',name]);
    }
  }
}
let complete = false;
process.on('beforeExit', () => {
  if (!complete) { console.error('Docker smoke did not complete'); process.exitCode = 1; }
});
main().then(() => { complete = true; }).catch(error=>{console.error(error.message);process.exitCode=1;});
