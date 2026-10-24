import { readFile } from 'node:fs/promises';

async function initialize(env) {
  const {createApp}=await import('../server.mjs');
  const seed=JSON.parse(await readFile(new URL('../config/loja.json',import.meta.url),'utf8'));
  if(env.DATABASE_PROVIDER==='firestore'){
    const [{initializeApp,cert,getApps,deleteApp},{getFirestore},{createFirestoreStore}]=await Promise.all([import('firebase-admin/app'),import('firebase-admin/firestore'),import('../lib/firestore-store.mjs')]);
    const firebase=getApps().find(app=>app.name==='mdl-backend')||initializeApp({credential:cert({projectId:env.FIREBASE_PROJECT_ID,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')}),projectId:env.FIREBASE_PROJECT_ID},'mdl-backend');
    const db=getFirestore(firebase);
    try{
      const store=await createFirestoreStore(db,seed);
      return await createApp({store,publicOrigin:env.PUBLIC_ORIGIN,apiOrigin:env.API_ORIGIN||'https://mestredoslanchesbackend.vercel.app',adminPassword:env.MDL_ADMIN_PASSWORD,trustVercelProxy:env.VERCEL==='1',serveFrontend:false});
    }catch(error){await db.terminate();await deleteApp(firebase);throw error;}
  }
  const [{createClient},{createRemoteStore}]=await Promise.all([import('@libsql/client/web'),import('../lib/remote-store.mjs')]);
  const client=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
  try {
    const store=await createRemoteStore(client,seed);
    return await createApp({store,publicOrigin:env.PUBLIC_ORIGIN,apiOrigin:env.API_ORIGIN || 'https://mestredoslanchesbackend.vercel.app',adminPassword:env.MDL_ADMIN_PASSWORD,trustVercelProxy:env.VERCEL==='1',serveFrontend:false});
  } catch(error) { client.close();throw error; }
}

export function createVercelHandler({env=process.env,initializeApp=initialize}={}) {
  let initialization;
  return async function handler(req,res) {
    const firestore=env.DATABASE_PROVIDER==='firestore';
    const databaseKeys=firestore?['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY']:['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN'];
    const missing=[...databaseKeys,'PUBLIC_ORIGIN','MDL_ADMIN_PASSWORD'].filter(key=>!env[key]);
    if(missing.length) {
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,code:'CONFIGURATION_REQUIRED',error:'Configure o banco externo e as variáveis do backend no Vercel.',missing}));return;
    }
    try {
      const publicUrl=new URL(env.PUBLIC_ORIGIN);
      const apiUrl=new URL(env.API_ORIGIN || 'https://mestredoslanchesbackend.vercel.app');
      if(publicUrl.protocol!=='https:' || publicUrl.origin!==env.PUBLIC_ORIGIN || apiUrl.protocol!=='https:' || apiUrl.origin!==(env.API_ORIGIN || apiUrl.origin) || (env.DATABASE_PROVIDER&&!['firestore','turso'].includes(env.DATABASE_PROVIDER)) || (!firestore&&!['libsql:','https:'].includes(new URL(env.TURSO_DATABASE_URL).protocol)))throw Object.assign(Error('Invalid configuration'),{code:'INVALID_CONFIGURATION'});
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
