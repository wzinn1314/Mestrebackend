import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@libsql/client';
import {createRemoteStore} from '../lib/remote-store.mjs';
import {createApp} from '../server.mjs';
const seed={minimumSubtotalCents:3000,cardapio:[{id:'lanches',nome:'Lanches',itens:[{id:'teste',nome:'Lanche do teste',desc:'',preco:15}]}]};
const body=()=>({customer:'Cliente Teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'dinheiro',needsChange:true,changeForCents:5000,notes:'Sem cebola',items:[{id:'teste',qty:2}],expectedTotalCents:3000});
const memory=()=>createRemoteStore(createClient({url:'file::memory:'}),seed);

test('libSQL: acesso, total, troco, status e reenvio são persistidos',async()=>{
  const store=await memory();
  try{
    await store.ensureAdmin('82619304');
    await assert.rejects(()=>store.login('00000000'),{status:401});
    const session=await store.login('82619304');assert.equal(await store.authenticated(session),true);
    const key=randomUUID(),pair=await Promise.all([store.placeOrder(body(),key),store.placeOrder(body(),key)]);
    assert.equal(pair[0].id,pair[1].id);assert.equal((await store.orders()).length,1);
    const order=await store.order(pair[0].id);assert.equal(order.totalCents,3000);assert.equal(order.changeForCents,5000);assert.equal(order.notes,'Sem cebola');
    assert.equal((await store.track(order.id,pair[0].trackingToken)).status,'novo');
    await assert.rejects(()=>store.placeOrder({...body(),changeForCents:10000},key),{status:409});
    await assert.rejects(()=>store.placeOrder({...body(),changeForCents:100},randomUUID()),{status:400});
    const confirmed=await store.changeStatus(order.id,{status:'confirmado',version:1});assert.equal(confirmed.version,2);
    await assert.rejects(()=>store.changeStatus(order.id,{status:'confirmado',version:1}),{status:409});
    assert.equal((await store.order(order.id)).history.length,2);
    await store.updateStoreStatus({acceptingOrders:false});await assert.rejects(()=>store.placeOrder(body(),randomUUID()),{status:409});
    await store.logout(session);assert.equal(await store.authenticated(session),false);
  }finally{store.close();}
});

test('libSQL: instâncias compartilham pedidos, autenticação e limites',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mdl-libsql-')),url='file:'+path.join(directory,'db.sqlite');
  let a,b;
  try{
    a=await createRemoteStore(createClient({url}),seed);b=await createRemoteStore(createClient({url}),seed);
    await a.ensureAdmin('82619304');await b.ensureAdmin('93720415');
    const session=await b.login('82619304');assert.equal(await a.authenticated(session),true);
    const key=randomUUID(),pair=[await a.placeOrder(body(),key),await b.placeOrder(body(),key)];
    assert.equal(pair[0].id,pair[1].id);assert.equal((await b.orders()).length,1);
    assert.equal(await a.consumeRateLimit('cliente-a',2,60000),true);assert.equal(await b.consumeRateLimit('cliente-a',2,60000),true);assert.equal(await a.consumeRateLimit('cliente-a',2,60000),false);assert.equal(await b.consumeRateLimit('cliente-b',2,60000),true);
    a.close();a=undefined;b.close();b=await createRemoteStore(createClient({url}),seed);assert.equal((await b.order(pair[0].id)).totalCents,3000);
  }finally{a?.close();b?.close();await rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:100});}
});

test('HTTP: store remoto, dominio separado, cookies e IPs distintos no Vercel',async()=>{
  const store=await memory(),publicOrigin='https://cliente.example';
  const app=await createApp({store,publicOrigin,apiOrigin:'https://backend.example',adminPassword:'82619304',trustVercelProxy:true,serveFrontend:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const request=(url,{method='GET',data,cookie='',origin=publicOrigin,ip='203.0.113.1'}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:url,method,headers:{Host:'backend.example',Origin:origin,'Content-Type':'application/json',Cookie:cookie,'x-vercel-forwarded-for':ip}},res=>{let data='';res.on('data',part=>data+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}));});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
  try{
    assert.equal((await request('/')).status,200);assert.equal((await request('/api/health')).body.ok,true);
    assert.equal((await request('/api/admin/orders')).status,401);
    const catalog=await request('/api/catalog');assert.equal(catalog.body.cardapio[0].itens[0].preco,15);
    for(let i=0;i<8;i++)assert.equal((await request('/api/admin/login',{method:'POST',data:{password:'errada'}})).status,401);
    assert.equal((await request('/api/admin/login',{method:'POST',data:{password:'82619304'}})).status,429);
    const login=await request('/api/admin/login',{method:'POST',ip:'203.0.113.2',data:{password:'82619304'}});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict;.*Secure/);
    const cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal((await request('/api/admin/orders',{cookie})).status,200);
    assert.equal((await request('/api/admin/store-status',{method:'PATCH',cookie,origin:'https://invasor.example',data:{acceptingOrders:false}})).status,403);
  }finally{await app.close();}
});
