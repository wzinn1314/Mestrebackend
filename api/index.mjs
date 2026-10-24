import { readFile } from 'node:fs/promises';

async function initialize(env) {
  const [{createClient},{createApp},{createRemoteStore}]=await Promise.all([import('@libsql/client/web'),import('../server.mjs'),import('../lib/remote-store.mjs')]);
  const client=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
  try {
    const seed=JSON.parse(await readFile(new URL('../config/loja.json',import.meta.url),'utf8'));
    const store=await createRemoteStore(client,seed);
    return await createApp({store,publicOrigin:env.PUBLIC_ORIGIN,apiOrigin:env.API_ORIGIN || 'https://mestredoslanchesbackend.vercel.app',adminPassword:env.MDL_ADMIN_PASSWORD,trustVercelProxy:env.VERCEL==='1',serveFrontend:false});
  } catch(error) { client.close();throw error; }
}

export function createVercelHandler({env=process.env,initializeApp=initialize}={}) {
  let initialization;
  return async function handler(req,res) {
    const missing=['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','PUBLIC_ORIGIN','MDL_ADMIN_PASSWORD'].filter(key=>!env[key]);
    if(missing.length) {
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,code:'CONFIGURATION_REQUIRED',error:'Configure o banco externo e as variáveis do backend no Vercel.',missing}));return;
    }
    try {
      const publicUrl=new URL(env.PUBLIC_ORIGIN);
      const databaseUrl=new URL(env.TURSO_DATABASE_URL);
      const apiUrl=new URL(env.API_ORIGIN || 'https://mestredoslanchesbackend.vercel.app');
      if(publicUrl.protocol!=='https:' || publicUrl.origin!==env.PUBLIC_ORIGIN || apiUrl.protocol!=='https:' || apiUrl.origin!==(env.API_ORIGIN || apiUrl.origin) || !['libsql:','https:'].includes(databaseUrl.protocol))throw Object.assign(Error('Invalid configuration'),{code:'INVALID_CONFIGURATION'});
      initialization ||= initializeApp(env);
      const app=await initialization;
      const url=new URL(req.url,'https://internal.invalid');
      if(url.searchParams.has('route')) {
        const route=url.searchParams.get('route');
        if(!/^[a-zA-Z0-9/_-]*$/.test(route)) {res.writeHead(400);res.end();return;}
        req.url='/api/'+route;
      } else if(url.pathname==='/api/index')req.url='/';
      await app.server.listeners('request')[0](req,res);
    } catch(error) {
      initialization=undefined;
      console.error('Falha ao inicializar a API:',error.code || error.name);
      if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,code:'SERVICE_UNAVAILABLE',error:'Não foi possível iniciar a API. Confira as variáveis de ambiente e a conexão com o banco nos logs do Vercel.'}));}
      else res.end();
    }
  };
}

export default createVercelHandler();
