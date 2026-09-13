// Build first. Metadata inspection never initializes the app, scheduler or DB.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://metadata:metadata@127.0.0.1:1/metadata';
process.env.DATABASE_SSL_MODE = 'disable';
const fs = require('node:fs');
const path = require('node:path');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/src/app.module');
const { createOpenApiDocument } = require('../dist/src/openapi');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;
async function main() {
  const module = await Test.createTestingModule({imports:[AppModule]}).compile();
  const app = module.createNestApplication({logger:false});
  try {
    app.setGlobalPrefix('api/v1');
    const document = createOpenApiDocument(app);
    const content = JSON.stringify(stable(document),null,2)+'\n';
    const file = path.join(__dirname,'../docs/openapi.json');
    if(process.argv.includes('--write')) fs.writeFileSync(file,content);
    else if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content) throw new Error('OpenAPI drift: build, inspect runtime changes and run npm run contract:update');
    console.log(JSON.stringify({paths:Object.keys(document.paths).length,schemas:Object.keys(document.components.schemas).length,result:'PASS'}));
  } finally { await app.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
