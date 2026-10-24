import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@libsql/client';
import {createRemoteStore} from '../lib/remote-store.mjs';
import {createApp} from '../server.mjs';
import {createVercelHandler} from '../api/index.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const invoke=async(handler,url,body)=>{
  let status,headers,payload;
  const req={url,body,method:body?'POST':'GET',headers:{host:'backend.example',origin:'https://cliente.example','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}};
  const res={headersSent:false,setHeader(){},writeHead(value,fields){status=value;headers=fields;this.headersSent=true;},end(value){payload=value;}};
  await handler(req,res);return {status,headers,body:JSON.parse(payload)};
};

test('Vercel: configuração ausente retorna 503 explicativo sem usar SQLite temporário',async()=>{
  let initialized=false;
  const result=await invoke(createVercelHandler({env:{},initializeApp:async()=>{initialized=true;}}),'/');
  assert.equal(result.status,503);assert.equal(result.body.code,'CONFIGURATION_REQUIRED');assert(result.body.missing.includes('TURSO_DATABASE_URL'));assert.equal(initialized,false);
});

test('Vercel: reutiliza conexão, encaminha rota e recebe JSON já processado pela plataforma',async()=>{
  const env={TURSO_DATABASE_URL:'libsql://teste.turso.io',TURSO_AUTH_TOKEN:'token-somente-teste',PUBLIC_ORIGIN:'https://cliente.example',API_ORIGIN:'https://backend.example',MDL_ADMIN_PASSWORD:'82619304'};
  let initialized=0,app;
  const handler=createVercelHandler({env,initializeApp:async()=>{
    initialized++;
    const store=await createRemoteStore(createClient({url:'file::memory:'}),{minimumSubtotalCents:3000,cardapio:[]});
    app=await createApp({store,publicOrigin:env.PUBLIC_ORIGIN,apiOrigin:env.API_ORIGIN,adminPassword:env.MDL_ADMIN_PASSWORD,serveFrontend:false});return app;
  }});
  try{
    assert.equal((await invoke(handler,'/api/index')).body.ok,true);
    assert.equal((await invoke(handler,'/api/index?route=health')).body.ok,true);
    const login=await invoke(handler,'/api/index?route=admin/login',{password:'82619304'});assert.equal(login.status,200);
    assert.equal(initialized,1);
  }finally{if(app)await app.close();}
});

test('Vercel: cliente não pode trocar o banco para um arquivo local',async()=>{
  const handler=createVercelHandler({env:{TURSO_DATABASE_URL:'file:/tmp/db.sqlite',TURSO_AUTH_TOKEN:'teste',PUBLIC_ORIGIN:'https://cliente.example',MDL_ADMIN_PASSWORD:'82619304'}});
  assert.equal((await invoke(handler,'/')).status,503);
});

test('Vercel: frontend encaminha somente /api para o backend configurado',async()=>{
  const config=JSON.parse(await readFile(new URL('../../frontend/vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(config.rewrites,[{source:'/api/:path*',destination:'https://mestredoslanchesbackend.vercel.app/api/:path*'}]);
});

test('Vercel: entrada principal não abre servidor nem SQLite local na nuvem',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const env={...process.env,VERCEL:'1',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:'',PUBLIC_ORIGIN:'',MDL_ADMIN_PASSWORD:''};
  await promisify(execFile)(process.execPath,['--no-experimental-sqlite','server.mjs'],{cwd:root,env,timeout:5000,windowsHide:true});
  const script="const {default:handler}=await import('./server.mjs');let status;const res={writeHead(value){status=value;},end(data){console.log(status+':'+JSON.parse(data).code);}};await handler({url:'/',headers:{},socket:{}},res);";
  const {stdout}=await promisify(execFile)(process.execPath,['--no-experimental-sqlite','--input-type=module','-e',script],{cwd:root,env,timeout:5000,windowsHide:true});
  assert.match(stdout,/503:CONFIGURATION_REQUIRED/);
});
