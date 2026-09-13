// Descriptive wire schemas from checked controller return types, never domain models.
// Explicit unknown/JSON values stay open. HTTP tests remain necessary: TypeScript
// cannot prove exceptions, interceptors, runtime casts or data migrations.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname,'..');
const config = ts.readConfigFile(path.join(root,'tsconfig.build.json'),ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config,ts.sys,root);
const program = ts.createProgram(parsed.fileNames,{...parsed.options,incremental:false});
const errors = ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error);
if(errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
const checker = program.getTypeChecker();
const schemas = {};
const seen = new Map();
const open = [];
let id = 0;
function convert(type, context) {
  const f=type.flags;
  if(['JsonValue','InputJsonValue'].includes(type.aliasSymbol?.name)) {open.push(context);return {};}
  if(f & (ts.TypeFlags.Any|ts.TypeFlags.Unknown)) { open.push(context); return {}; }
  if(f & (ts.TypeFlags.Void|ts.TypeFlags.Undefined)) return {};
  if(f & ts.TypeFlags.Null) return {enum:[null],nullable:true};
  if(seen.has(type))return {$ref:'#/components/schemas/'+seen.get(type)};
  if(type.isUnion()) {
    const parts=type.types.filter(t=>!(t.flags & ts.TypeFlags.Undefined));
    const literal=parts.every(t=>t.isLiteral()||t.flags&ts.TypeFlags.BooleanLiteral);
    if(literal) return {enum:parts.map(t=>t.flags&ts.TypeFlags.BooleanLiteral?t.intrinsicName==='true':t.value)};
    const name='Wire'+(++id);seen.set(type,name);schemas[name]={};
    schemas[name]={anyOf:parts.map(t=>convert(t,context))};
    return {$ref:'#/components/schemas/'+name};
  }
  if(f&ts.TypeFlags.StringLiteral)return {type:'string',enum:[type.value]};
  if(f&ts.TypeFlags.NumberLiteral)return {type:'number',enum:[type.value]};
  if(f&ts.TypeFlags.BooleanLiteral)return {type:'boolean',enum:[type.intrinsicName==='true']};
  if(f&ts.TypeFlags.StringLike)return {type:'string'};
  if(f&ts.TypeFlags.NumberLike)return {type:'number'};
  if(f&ts.TypeFlags.BooleanLike)return {type:'boolean'};
  if(type.symbol?.name==='Date')return {type:'string',format:'date-time'};
  const indexed = checker.getIndexTypeOfType(type,ts.IndexKind.Number);
  if(checker.isArrayType(type) || (indexed && checker.getPropertyOfType(type,'length'))) {
    const name='Wire'+(++id);seen.set(type,name);schemas[name]={};
    schemas[name]={type:'array',items:convert(indexed || checker.getTypeArguments(type)[0],context+'[]')};
    return {$ref:'#/components/schemas/'+name};
  }
  if(f&ts.TypeFlags.Never)return {not:{}};
  if(seen.has(type))return {$ref:'#/components/schemas/'+seen.get(type)};
  if(!(f&ts.TypeFlags.Object)&&!type.isIntersection())throw Error('Unsupported response type '+checker.typeToString(type)+' at '+context);
  const name='Wire'+(++id);
  seen.set(type,name);
  const result={type:'object',properties:{}};
  schemas[name]=result;
  const required=[];
  for(const property of checker.getPropertiesOfType(type)) {
    const declaration=property.valueDeclaration||property.declarations?.[0];
    const valueType=declaration ? checker.getTypeOfSymbolAtLocation(property,declaration) : checker.getTypeOfSymbol(property);
    if(valueType.getCallSignatures().length)continue;
    result.properties[property.name]=convert(valueType,context+'.'+property.name);
    const optional=property.flags&ts.SymbolFlags.Optional || valueType.flags&ts.TypeFlags.Undefined || (valueType.isUnion()&&valueType.types.some(t=>t.flags&ts.TypeFlags.Undefined));
    if(!optional)required.push(property.name);
  }
  if(required.length)result.required=required;
  const index=checker.getIndexTypeOfType(type,ts.IndexKind.String);
  if(index)result.additionalProperties=convert(index,context+'.*');
  return {$ref:'#/components/schemas/'+name};
}
const operations={};
const dtos=[];
for(const file of program.getSourceFiles().filter(f=>f.fileName.replaceAll('\\','/').startsWith(root.replaceAll('\\','/')+'/src/')).sort((a,b)=>a.fileName.localeCompare(b.fileName,'en'))) {
 for(const node of file.statements) {
  if(!ts.isClassDeclaration(node)||!node.name)continue;
  if(file.fileName.endsWith('.dto.ts')&&node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) dtos.push({name:node.name.text,file:path.relative(path.join(root,'src/contracts'),file.fileName).replaceAll('\\','/').replace(/\.ts$/,'')});
  for(const method of node.members) {
   if(!ts.isMethodDeclaration(method))continue;
   const decorators=ts.getDecorators(method)||[];
   const verb=decorators.map(d=>/^@(Get|Post|Put|Patch|Delete)\(/.exec(d.getText(file))?.[1]).find(Boolean);
   if(!verb)continue;
   const operation=node.name.text+'_'+method.name.getText(file);
   const type=checker.getAwaitedType(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(method)));
   const parameters=[];
   for(const p of method.parameters)for(const d of ts.getDecorators(p)||[]) {
     const match=/^@(Query|Param|Headers)\(['"]([^'"]+)['"]/.exec(d.getText(file));
     if(match) parameters.push({name:match[2],in:match[1]==='Query'?'query':match[1]==='Param'?'path':'header',required:match[1]==='Param'||!(p.questionToken||p.initializer||p.type?.getText(file).includes('undefined'))});
   }
   operations[operation]={schema:convert(type,operation),dataOptional:!!(type.flags&(ts.TypeFlags.Void|ts.TypeFlags.Undefined)),parameters};
  }
 }
}
const output=JSON.stringify({operations,schemas,openTypes:[...new Set(open)].sort()},null,2)+'\n';
const dest=path.join(root,'src/contracts/response-contracts.json');
if(process.argv.includes('--write')) {fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,output);}
else if(!fs.existsSync(dest)||fs.readFileSync(dest,'utf8')!==output)throw Error('Controller response drift: inspect runtime and regenerate contracts');
console.log(JSON.stringify({operations:Object.keys(operations).length,schemas:Object.keys(schemas).length,openTypes:new Set(open).size,result:'PASS'}));
const registry='// Generated DTO metadata registry; regenerate with contract:update.\n'+dtos.map((d,i)=>`import { ${d.name} as D${i} } from '${d.file}';`).join('\n')+'\nexport const requestDtos = ['+dtos.map((d,i)=>'D'+i).join(', ')+'];\n';
const registryFile=path.join(root,'src/contracts/request-dtos.ts');
void (async()=>{
  const prettier=require('prettier');
  const formatted=await prettier.format(registry,{...await prettier.resolveConfig(registryFile),filepath:registryFile});
  if(process.argv.includes('--write'))fs.writeFileSync(registryFile,formatted);
  else if(!fs.existsSync(registryFile)||fs.readFileSync(registryFile,'utf8')!==formatted)throw Error('DTO registry drift');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
