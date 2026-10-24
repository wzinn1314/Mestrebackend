import http from 'node:http';
import { isIP } from 'node:net';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAddressService } from './lib/address.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const frontendRoot=path.resolve(root,'../frontend');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
const bad=(message,status=400)=>{ throw Object.assign(new Error(message),{status}); };

export async function createApp({database,publicOrigin,adminPassword,now,store:providedStore,apiOrigin,trustVercelProxy=false,serveFrontend=true,addressService=createAddressService()}={}) {
  if (!database && !providedStore) { await mkdir(path.join(root,'data'),{recursive:true});database=path.join(root,'data','loja.sqlite'); }
  const config=JSON.parse(await readFile(path.join(root,'config','loja.json'),'utf8'));
  const store=providedStore || (await import('./lib/store.mjs')).createStore(database,config,{now});
  if(adminPassword){if(store.ensureAdmin)await store.ensureAdmin(adminPassword);else if(!await store.hasAdmin())await store.setup(adminPassword);}
  const limits=new Map();
  const rate=async(key,max,interval)=>{
    if(store.consumeRateLimit){if(!await store.consumeRateLimit(key,max,interval))bad('Muitas tentativas. Aguarde alguns minutos.',429);return;}
    const now=Date.now();
    if (limits.size>5000) for(const [id,value] of limits) if (value.until<now) limits.delete(id);
    const current=limits.get(key);
    if (!current || current.until<now) { limits.set(key,{count:1,until:now+interval});return; }
    if (++current.count>max) bad('Muitas tentativas. Aguarde alguns minutos.',429);
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com https://qd.thewisecloud.com; frame-src https://maps.google.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try {
      const host=req.headers.host || '';
      const actualOrigin=`http://${host}`;
      const expected=publicOrigin || actualOrigin;
      if (publicOrigin ? ![new URL(publicOrigin).host,...(apiOrigin?[new URL(apiOrigin).host]:[])].includes(host) : !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) bad('Host não permitido.',403);
      const url=new URL(req.url,actualOrigin);
      const isMutation=['POST','PATCH','PUT','DELETE'].includes(req.method);
      if (isMutation && req.headers.origin !== expected) bad('Origem não permitida.',403);
      const forwarded=trustVercelProxy?String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim():'';
      const peer=isIP(forwarded)?forwarded:req.socket.remoteAddress;
      const session=(req.headers.cookie || '').split(';').map(part=>part.trim()).find(part=>part.startsWith('mdl_session='))?.slice(12);
      const admin=async()=>{if(!(await store.authenticated(session)))bad('Entre no painel para continuar.',401);};
      const body=async()=>{
        if (!(req.headers['content-type']||'').startsWith('application/json')) bad('Envie os dados em JSON.',415);
        const chunks=[];let length=0;
        if(req.body!==undefined){const encoded=Buffer.isBuffer(req.body)?req.body:Buffer.from(typeof req.body==='string'?req.body:JSON.stringify(req.body));if(encoded.length>32768)bad('Pedido muito grande.',413);chunks.push(encoded);}
        else for await (const chunk of req) { length+=chunk.length;if(length>32768)bad('Pedido muito grande.',413);chunks.push(chunk); }
        try { const result=JSON.parse(Buffer.concat(chunks).toString());if(!result || typeof result!=='object' || Array.isArray(result))bad('Dados inválidos.');return result; }
        catch(error) {if(error.status)throw error;bad('Dados inválidos.');}
      };
      const localSetup=()=>!publicOrigin && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
      const cookie=token=>`mdl_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin?.startsWith('https:')?'; Secure':''}`;
      if(req.method==='GET' && (url.pathname==='/api/health' || (!serveFrontend && url.pathname==='/')))return json({ok:true,service:'Mestre dos Lanches API'});
      if(!serveFrontend && !url.pathname.startsWith('/api/'))bad('Endereço não encontrado.',404);
      if(req.method==='GET' && url.pathname==='/api/catalog')return json((await store.catalog()));
      if(req.method==='GET' && url.pathname==='/api/store-status')return json({acceptingOrders:(await store.settings()).acceptingOrders});
      if(req.method==='PATCH' && url.pathname==='/api/admin/store-status'){await admin();return json((await store.updateStoreStatus(await body())));}
      const cepMatch=url.pathname.match(/^\/api\/address\/(\d{8})$/);
      if(req.method==='GET' && cepMatch){await rate(`cep:${peer}`,40,60000);return json(await addressService.lookup(cepMatch[1]));}
      if(req.method==='GET' && url.pathname==='/api/admin/session')return json({authenticated:(await store.authenticated(session)),needsSetup:!(await store.hasAdmin()) && localSetup()});
      if(req.method==='POST' && url.pathname==='/api/admin/setup') {
        if(!localSetup())bad('Configure o acesso pelo servidor local.',403);
        await rate(`auth:${peer}`,8,600000);const input=await body();(await store.setup(input.password));
        res.setHeader('Set-Cookie',cookie((await store.login(input.password))));return json({ok:true},201);
      }
      if(req.method==='POST' && url.pathname==='/api/admin/login') {
        await rate(`auth:${peer}`,8,600000);const input=await body();res.setHeader('Set-Cookie',cookie((await store.login(input.password))));return json({ok:true});
      }
      if(req.method==='POST' && url.pathname==='/api/admin/logout') {
        await admin();(await store.logout(session));res.setHeader('Set-Cookie','mdl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json({ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/admin/orders') {await admin();return json({orders:(await store.orders())});}
      if(req.method==='PATCH' && url.pathname==='/api/admin/settings') {await admin();return json((await store.updateSettings(await body())));}
      if(req.method==='POST' && url.pathname==='/api/admin/products'){await admin();return json(await store.createProduct(await body()),201);}
      const productMatch=url.pathname.match(/^\/api\/admin\/products\/([a-zA-Z0-9_-]+)$/);
      if(req.method==='PATCH' && productMatch) {await admin();(await store.updateProduct(productMatch[1],await body()));return json({ok:true});}
      const statusMatch=url.pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/);
      if(req.method==='GET' && statusMatch) {await admin();return json((await store.order(statusMatch[1])));}
      if(req.method==='PATCH' && statusMatch) {await admin();return json((await store.changeStatus(statusMatch[1],await body())));}
      if(req.method==='POST' && url.pathname==='/api/orders') {
        await rate(`order:${peer}`,30,600000);const input=await body();const verifiedAddress=input.fulfillment==='entrega'?await addressService.verify(input.deliveryAddress):null;const order=(await store.placeOrder(input,req.headers['idempotency-key'],{verifiedAddress}));return json(order,order.replayed?200:201);
      }
      const trackingMatch=url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/);
      if(req.method==='GET' && trackingMatch) {
        await rate(`track:${peer}`,300,60000);return json((await store.track(trackingMatch[1],req.headers.authorization?.replace(/^Bearer /,''))));
      }
      if(url.pathname.startsWith('/api/'))bad('Endereço não encontrado.',404);
      if(!['GET','HEAD'].includes(req.method))bad('Método não permitido.',405);
      const pathname=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
      if(!/^\/(?:index\.html|pedidos\.html|informacoes\.html|painel\.html|acompanhar\.html|imprimir\.html|(?:assets|css|js)\/[a-zA-Z0-9_./-]+)$/.test(pathname) || pathname.split('/').includes('..'))bad('Arquivo não encontrado.',404);
      const extension=path.extname(pathname);
      if(!mime[extension])bad('Arquivo não encontrado.',404);
      let content;
      try{content=await readFile(path.join(frontendRoot,pathname));}catch{bad('Arquivo não encontrado.',404);}
      res.writeHead(200,{'Content-Type':mime[extension],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(error){
      if(!res.headersSent)json({error:error.status?error.message:'Não foi possível processar a solicitação.'},error.status||500);
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,close:()=>new Promise(resolve=>{server.close(async()=>{await store.close();resolve();});server.closeIdleConnections();})};
}

if(!process.env.VERCEL && process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 3000);
  const host=process.env.HOST || '127.0.0.1';
  if(host!=='127.0.0.1' && !process.env.PUBLIC_ORIGIN)throw Error('Defina PUBLIC_ORIGIN antes de disponibilizar o servidor em rede.');
  let store;
  if(process.env.DATABASE_PROVIDER==='postgres'){
    const {createPostgresStore}=await import('./lib/postgres-store.mjs');
    const seed=JSON.parse(await readFile(new URL('./config/loja.json',import.meta.url),'utf8'));
    store=await createPostgresStore(process.env.DATABASE_URL,seed);
  }
  const app=await createApp({store,publicOrigin:process.env.PUBLIC_ORIGIN,adminPassword:process.env.MDL_ADMIN_PASSWORD});
  app.server.listen(port,host,()=>console.log(`Mestre dos Lanches: http://localhost:${port}\nPainel da lanchonete: http://localhost:${port}/painel.html`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}

// Suporta projetos Vercel que apontem para este arquivo como entrada.
export default async function handler(req,res){
  try{const {default:vercelHandler}=await import('./api/index.mjs');return await vercelHandler(req,res);}
  catch(error){console.error('Falha na entrada da API:',error.code || error.name);if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,code:'STARTUP_FAILED',error:'A API não iniciou. Confira os logs e a configuração do deploy no Vercel.'}));}else res.end();}
}
