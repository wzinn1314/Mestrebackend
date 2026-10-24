import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createAddressService } from '../lib/address.mjs';

const seed={minimumSubtotalCents:1000,cardapio:[{id:'lanches',nome:'Lanches',itens:[{nome:'Produto do teste',desc:'Usado apenas nos testes',preco:19.9},{nome:'Sem preço',desc:'Usado apenas nos testes'}]}]};
const deliveryAddress={cep:'56000000',street:'Rua do Teste',number:'123',neighborhood:'Santa Margarida',complement:''};
const verifiedAddress={cep:'56000000',level:'city',city:'Salgueiro',state:'PE',formatted:'Rua do Teste, 123 - Santa Margarida - Salgueiro/PE - CEP 56000-000'};
const payload=()=>({customer:'Cliente do teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'pix',address:'',notes:'Sem cebola',items:[{id:'lanches-0',qty:2}],expectedTotalCents:3980});

test('pagamentos: aceita as três opções, rejeita valores inválidos e protege reenvios',()=>{
  const store=createStore(':memory:',seed);
  try{
    for(const paymentMethod of ['pix','cartao','dinheiro']){
      const key=randomUUID(),body={...payload(),paymentMethod},order=store.placeOrder(body,key);
      assert.equal(store.order(order.id).paymentMethod,paymentMethod);
      assert.equal(store.track(order.id,order.trackingToken).paymentMethod,paymentMethod);
      assert.equal(store.placeOrder(body,key).id,order.id);
      assert.throws(()=>store.placeOrder({...body,paymentMethod:paymentMethod==='pix'?'cartao':'pix'},key),{status:409});
    }
    for(const paymentMethod of [undefined,'', 'credito', '<script>'])assert.throws(()=>store.placeOrder({...payload(),paymentMethod},randomUUID()),{status:400});
  }finally{store.close();}
});

test('migração: adiciona pagamento sem perder pedidos ou acesso já existentes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mdl-payment-migration-')),filename=path.join(dir,'legacy.sqlite');
  let store=createStore(filename,seed);
  try{
    store.setup('SenhaSomenteParaTeste123!');
    const old=store.placeOrder(payload(),randomUUID());
    store.close();
    const legacy=new DatabaseSync(filename);legacy.exec('ALTER TABLE orders DROP COLUMN payment_method');legacy.close();
    store=createStore(filename,seed);
    assert.equal(store.hasAdmin(),true);
    assert.equal(store.order(old.id).totalCents,3980);
    assert.equal(store.order(old.id).paymentMethod,null);
    assert.equal(store.order(old.id).customer,payload().customer);
    assert.equal(store.placeOrder({...payload(),paymentMethod:'dinheiro'},randomUUID()).paymentMethod,'dinheiro');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('pedido: calcula no servidor, evita duplicação e protege o acompanhamento',()=>{
  const store=createStore(':memory:',seed);
  try{
    const body=payload(),key=randomUUID();
    assert.throws(()=>store.placeOrder({...body,expectedTotalCents:1},randomUUID()),{status:409});
    assert.throws(()=>store.placeOrder({...body,items:[{id:'lanches-1',qty:1}]},randomUUID()),{status:409});
    store.updateSettings({deliveryFeeCents:null,minimumSubtotalCents:1000,acceptingOrders:true});
    assert.throws(()=>store.placeOrder({...body,fulfillment:'entrega',deliveryAddress},randomUUID(),{verifiedAddress}),{status:409});
    const order=store.placeOrder(body,key);
    assert.equal(order.totalCents,3980);
    assert.equal(store.placeOrder(body,key).id,order.id);
    assert.equal(store.placeOrder(body,key).trackingToken,order.trackingToken);
    assert.equal(store.orders().length,1);
    assert.throws(()=>store.placeOrder({...body,notes:'outro pedido'},key),{status:409});
    assert.throws(()=>store.track(order.id,'incorreto'),{status:404});
    const tracking=store.track(order.id,order.trackingToken);
    assert.equal(tracking.paymentMethod,'pix');
    for(const field of ['phone','customer','address','notes','token','request_key'])assert.equal(tracking[field],undefined);
    assert.equal(store.orders()[0].phone,body.phone);
    assert.throws(()=>store.changeStatus(order.id,{status:'preparando',version:1}),{status:409});
    const confirmed=store.changeStatus(order.id,{status:'confirmado',version:1});
    assert.equal(confirmed.version,2);
    assert.throws(()=>store.changeStatus(order.id,{status:'preparando',version:1}),{status:409});
    store.changeStatus(order.id,{status:'preparando',version:2});
    assert.throws(()=>store.changeStatus(order.id,{status:'saiu',version:3}),{status:400});
    store.changeStatus(order.id,{status:'pronto',version:3});
    const done=store.changeStatus(order.id,{status:'concluido',version:4});
    assert.equal(done.history.length,5);
    assert.throws(()=>store.changeStatus(order.id,{status:'novo',version:5}),{status:409});
  }finally{store.close();}
});

test('entrega e disponibilidade: taxa em centavos e produtos desativados',()=>{
  const store=createStore(':memory:',seed);
  try{
    store.updateSettings({deliveryFeeCents:450,minimumSubtotalCents:1000,acceptingOrders:true});
    const order=store.placeOrder({...payload(),fulfillment:'entrega',deliveryAddress,expectedTotalCents:4430},randomUUID(),{verifiedAddress});
    assert.equal(order.deliveryFeeCents,450);
    store.updateProduct('lanches-0',{priceCents:1990,active:false});
    assert.throws(()=>store.placeOrder(payload(),randomUUID()),{status:409});
    store.updateProduct('lanches-0',{priceCents:1990,active:true});
    store.updateSettings({deliveryFeeCents:450,minimumSubtotalCents:1000,acceptingOrders:false});
    assert.throws(()=>store.placeOrder(payload(),randomUUID()),{status:409});
    assert.throws(()=>store.updateProduct('lanches-0',{priceCents:-1,active:true}),{status:400});
    assert.throws(()=>store.placeOrder({...payload(),items:[{id:'lanches-0',qty:0}]},randomUUID()),{status:400});
    assert.throws(()=>store.placeOrder({...payload(),phone:'123'},randomUUID()),{status:400});
  }finally{store.close();}
});

test('regras da loja: pedido mínimo, entrega grátis e abertura manual validados no servidor',()=>{
  const config={...seed,minimumSubtotalCents:3000,horario:{abre:'19:00',fecha:'23:30',fechaDomingo:true}};
  let current=new Date('2026-10-23T22:00:00Z');
  const store=createStore(':memory:',config,{now:()=>current});
  try{
    assert.equal(store.catalog().deliveryFeeCents,0);
    assert.equal(store.catalog().minimumSubtotalCents,3000);
    assert.equal(store.catalog().canOrder,true);
    assert.throws(()=>store.placeOrder({...payload(),items:[{id:'lanches-0',qty:1}],expectedTotalCents:1990},randomUUID()),/pedido mínimo/);
    const order=store.placeOrder({...payload(),fulfillment:'entrega',deliveryAddress},randomUUID(),{verifiedAddress});
    assert.equal(order.deliveryFeeCents,0);
    assert.equal(order.totalCents,3980);
    store.updateProduct('lanches-0',{priceCents:1500,active:true});
    assert.equal(store.placeOrder({...payload(),expectedTotalCents:3000},randomUUID()).totalCents,3000);
    current=new Date('2026-10-24T02:30:00Z');
    assert.equal(store.catalog().canOrder,true);
    store.updateStoreStatus({acceptingOrders:false});
    assert.equal(store.catalog().canOrder,false);
    assert.throws(()=>store.placeOrder(payload(),randomUUID()),/fechada/);
    store.updateStoreStatus({acceptingOrders:true});
    current=new Date('2026-10-25T22:00:00Z');
    assert.equal(store.catalog().canOrder,true);
    assert.equal(store.settings().minimumSubtotalCents,3000);
  }finally{store.close();}
});

test('SQLite: pedidos, acesso e preços permanecem após reiniciar',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mdl-persistence-')),filename=path.join(dir,'test.sqlite');
  let store=createStore(filename,seed);
  try{
    store.setup('SenhaSomenteParaTeste123!');
    const session=store.login('SenhaSomenteParaTeste123!');
    const key=randomUUID(),body=payload(),order=store.placeOrder(body,key);
    store.updateProduct('lanches-0',{priceCents:2500,active:true});
    store.close();store=createStore(filename,seed);
    assert.equal(store.authenticated(session),true);
    assert.equal(store.catalog().cardapio[0].itens[0].preco,25);
    assert.equal(store.track(order.id,order.trackingToken).totalCents,3980);
    assert.equal(store.track(order.id,order.trackingToken).paymentMethod,'pix');
    assert.equal(store.placeOrder(body,key).id,order.id);
    store.logout(session);assert.equal(store.authenticated(session),false);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP: acesso protegido, configuração inicial, sacola, status e arquivos privados',async()=>{
  const app=await createApp({database:':memory:',now:()=>new Date('2026-10-23T22:00:00Z'),addressService:createAddressService({fetchImpl:async()=>({ok:true,json:async()=>({localidade:'Salgueiro',uf:'PE',logradouro:'',bairro:''})})})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  async function request(url,{method='GET',data,headers={}}={}){
    const response=await fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();return {response,result};
  }
  try{
    assert.equal((await request('/api/admin/orders')).response.status,401);
    assert.equal((await request('/api/admin/store-status',{method:'PATCH',data:{acceptingOrders:false}})).response.status,401);
    assert.equal((await request('/api/admin/session')).result.needsSetup,true);
    assert.equal((await request('/api/admin/setup',{method:'POST',data:{password:'muito-curta'}})).response.status,400);
    const setup=await request('/api/admin/setup',{method:'POST',data:{password:'SenhaSomenteParaTeste123!'}});
    assert.equal(setup.response.status,201);
    cookie=setup.response.headers.get('set-cookie').split(';')[0];
    assert.match(setup.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/admin/setup',{method:'POST',data:{password:'SenhaSomenteParaTeste123!'}})).response.status,409);
    assert.equal((await request('/api/admin/settings',{method:'PATCH',data:{deliveryFeeCents:0,minimumSubtotalCents:1000,acceptingOrders:true},headers:{Origin:'https://outro-site.example'}})).response.status,403);
    assert.equal((await request('/api/admin/store-status',{method:'PATCH',data:{acceptingOrders:false}})).result.acceptingOrders,false);
    assert.equal((await request('/api/catalog')).result.canOrder,false);
    assert.equal((await request('/api/store-status')).result.acceptingOrders,false);
    assert.equal((await request('/api/admin/store-status',{method:'PATCH',data:{acceptingOrders:true}})).result.acceptingOrders,true);
    const catalog=(await request('/api/catalog')).result;
    const item=catalog.cardapio[0].itens[0];
    await request(`/api/admin/products/${item.id}`,{method:'PATCH',data:{priceCents:1990,active:true}});
    await request('/api/admin/settings',{method:'PATCH',data:{deliveryFeeCents:500,minimumSubtotalCents:1000,acceptingOrders:true}});
    const key=randomUUID(),body={...payload(),fulfillment:'entrega',deliveryAddress,expectedTotalCents:4480,items:[{id:item.id,qty:2}]};
    cookie='';
    const pair=await Promise.all([1,2].map(()=>request('/api/orders',{method:'POST',data:body,headers:{'Idempotency-Key':key}})));
    assert.deepEqual(pair.map(item=>item.response.status).sort(),[200,201]);
    assert.equal(pair[0].result.id,pair[1].result.id);
    const placed=pair.find(item=>item.response.status===201);
    assert.equal(placed.response.status,201);
    const order=placed.result;
    assert.equal((await request('/api/orders',{method:'POST',data:body,headers:{'Idempotency-Key':key}})).response.status,200);
    assert.equal((await request(`/api/orders/${order.id}`)).response.status,404);
    assert.equal((await request(`/api/admin/orders/${order.id}`)).response.status,401);
    assert.equal((await request(`/api/orders/${order.id}`,{headers:{Authorization:`Bearer ${order.trackingToken}`}})).result.totalCents,4480);
    const login=await request('/api/admin/login',{method:'POST',data:{password:'SenhaSomenteParaTeste123!'}});
    cookie=login.response.headers.get('set-cookie').split(';')[0];
    const list=await request('/api/admin/orders');assert.equal(list.result.orders.length,1);
    const receipt=await request(`/api/admin/orders/${order.id}`);
    assert.equal(receipt.response.status,200);assert.equal(receipt.result.customer,body.customer);assert.equal(receipt.result.items[0].qty,2);
    assert.equal(receipt.result.addressValidation.level,'city');
    assert.equal((await request(`/api/admin/orders/${order.id}`,{method:'PATCH',data:{status:'confirmado',version:1}})).response.status,400);
    const update=await request(`/api/admin/orders/${order.id}`,{method:'PATCH',data:{status:'confirmado',version:1,addressReviewed:true}});assert.equal(update.result.status,'confirmado');
    for(const file of ['/index.html','/pedidos.html','/painel.html','/acompanhar.html','/imprimir.html','/informacoes.html','/js/pedidos.js'])assert.equal((await fetch(origin+file)).status,200,file);
    for(const file of ['/server.mjs','/data/loja.sqlite','/.env','/lib/store.mjs','/backend/config/loja.json','/backend/data/loja.sqlite','/frontend/painel.html'])assert.equal((await fetch(origin+file)).status,404,file);
    await request('/api/admin/logout',{method:'POST',data:{}});
    assert.equal((await request('/api/admin/orders')).response.status,401);
  }finally{await app.close();}
});

 test('troco: valida, persiste no pedido e protege reenvio com valor alterado',()=>{
   const store=createStore(':memory:',seed);
   try{
     const key=randomUUID(),body={...payload(),paymentMethod:'dinheiro',needsChange:true,changeForCents:5000};
     const placed=store.placeOrder(body,key),order=store.order(placed.id);
     assert.equal(order.needsChange,true);assert.equal(order.changeForCents,5000);
     assert.equal(store.track(order.id,placed.trackingToken).changeForCents,5000);
     assert.equal(store.placeOrder(body,key).id,order.id);assert.equal(store.orders().length,1);
     assert.throws(()=>store.placeOrder({...body,changeForCents:10000},key),{status:409});
     for(const value of [null,100,NaN,Infinity,5000.5,1000001])assert.throws(()=>store.placeOrder({...body,changeForCents:value},randomUUID()),{status:400});
     assert.throws(()=>store.placeOrder({...body,paymentMethod:'pix'},randomUUID()),{status:400});
     const noChange=store.placeOrder({...body,needsChange:false,changeForCents:null},randomUUID());assert.equal(store.order(noChange.id).needsChange,false);
   }finally{store.close();}
 });
