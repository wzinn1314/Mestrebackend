import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script=await readFile(new URL('../../frontend/js/acompanhar.js',import.meta.url),'utf8');
const savedSource=await readFile(new URL('../../frontend/js/historico-pedidos.js',import.meta.url),'utf8');
const one={id:'1a052fe9-f6a6-4c28-bd45-f7490bb07ac4',token:'a'.repeat(43),code:'PED001'};
const two={id:'2a052fe9-f6a6-4c28-bd45-f7490bb07ac4',token:'b'.repeat(43),code:'PED002'};
const receipt=(status='novo',fulfillment='entrega')=>({id:one.id,code:'PED001',status,fulfillment,paymentMethod:'pix',createdAt:'2026-10-23T22:00:00Z',updatedAt:'2026-10-23T22:01:00Z',history:[{status,at:'2026-10-23T22:01:00Z'}],items:[{name:'Lanche do teste',qty:2,unitPriceCents:1800}],subtotalCents:3600,deliveryFeeCents:0,totalCents:3600});

async function client(records=[one]){
  const nodes=new Map(),storage=new Map([['mdl-order-history',JSON.stringify(records)]]);let interval,status='novo',fulfillment='entrega',lastUrl;
  const element=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',hidden:false,disabled:false,attrs:{},handlers:{},children:[],addEventListener(name,fn){this.handlers[name]=fn;},setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name];},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});return nodes.get(id);};
  const context={window:{history:{replaceState(){}},addEventListener(){}},document:{hidden:false,querySelector:element,createElement:()=>element(Symbol()),addEventListener(){}},location:{hash:'',origin:'http://localhost:3000',pathname:'/acompanhar.html'},navigator:{clipboard:{writeText:async()=>{}}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},setInterval:fn=>{interval=fn;},fetch:async url=>{lastUrl=url;return{ok:true,json:async()=>({...receipt(status,fulfillment),id:url.split('/').pop()})};}};
  vm.createContext(context);vm.runInContext(savedSource,context);context.window.MDLHttp={readJson:response=>response.json()};vm.runInContext(script,context);
  const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};await settle();
  return {element,storage,settle,async update(next,nextFulfillment='entrega'){status=next;fulfillment=nextFulfillment;interval();await settle();},get lastUrl(){return lastUrl;}};
}

test('cliente acompanha espera, produção e saída para entrega com atualização automática',async()=>{
  const app=await client();assert.equal(app.element('#tracking-status').textContent,'Em espera');assert.equal(app.element('#tracking-items').children.length,1);assert.equal(app.element('#tracking-total').textContent,'R$\u00a036,00');
  await app.update('preparando');assert.equal(app.element('#tracking-status').textContent,'Em produção');assert.equal(app.element('#tracking-steps').children[2].attrs['aria-current'],'step');
  await app.update('saiu');assert.equal(app.element('#tracking-status').textContent,'Saiu para entrega');assert.equal(app.element('#tracking-steps').children[3].attrs['aria-current'],'step');
  await app.update('concluido');assert.equal(app.element('#tracking-status').textContent,'Pedido concluído');
});
test('cliente escolhe outro pedido salvo usando sua própria chave de acompanhamento',async()=>{
  const app=await client([one,two]);assert.equal(app.element('#tracking-select').children.length,2);
  app.element('#tracking-select').handlers.change({target:{value:two.id}});await app.settle();assert.equal(app.lastUrl,'/api/orders/'+two.id);
});
test('acompanhamento diferencia retirada e informa ausência de pedidos',async()=>{
  const app=await client();await app.update('pronto','retirada');assert.equal(app.element('#tracking-status').textContent,'Pronto para retirada');assert.equal(app.element('#tracking-steps').children[3].children[1].textContent,'Pronto para retirada');
  const empty=await client([]);assert.equal(empty.element('#tracking-empty').hidden,false);assert.equal(empty.lastUrl,undefined);
});
test('histórico aceita link antigo, mantém vários pedidos e limita o armazenamento',()=>{
  const storage=new Map([['mdl-last-order',JSON.stringify(one)]]),context={window:{},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}};
  vm.runInNewContext(savedSource,context);const history=context.window.MDLOrderHistory;assert.equal(history.read()[0].id,one.id);history.save(two);assert.equal(history.read().length,2);assert.equal(history.save({id:'inválido',token:'x'}),false);
  for(let i=0;i<25;i++)history.save({id:`${i.toString(16).padStart(8,'0')}-f6a6-4c28-bd45-f7490bb07ac4`,token:'c'.repeat(43)});assert.equal(history.read().length,20);
});

 test('meus pedidos: mostra lista, aceita selecao por cartao e informa aceite ou cancelamento',async()=>{
   const app=await client([one,two]);
   assert.equal(app.element('#customer-orders-section').hidden,false);
   assert.equal(app.element('#customer-order-list').children.length,2);
   const card=app.element('#customer-order-list').children.find(item=>item.attrs['data-customer-order']===two.id);
   app.element('#customer-order-list').handlers.click({target:{closest:()=>card}});await app.settle();assert.equal(app.lastUrl,'/api/orders/'+two.id);
   await app.update('confirmado');assert.equal(app.element('#tracking-steps').children[1].attrs['aria-current'],'step');assert.match(app.element('#tracking-description').textContent,/confirmou/);
   await app.update('cancelado');assert.equal(app.element('#tracking-status').textContent,'Pedido cancelado');assert.equal(app.element('#tracking-steps').hidden,true);assert.match(app.element('#tracking-description').textContent,/cancelou/);
 });

 test('cancelados: aba separa os pedidos cancelados dos demais sem compartilhar link',async()=>{
   const app=await client();await app.update('cancelado');
   assert.equal(app.element('#customer-order-list').children.length,0);
   app.element('#show-cancelled-orders').handlers.click();await app.settle();
   assert.equal(app.element('#customer-order-list').children.length,1);assert.equal(app.element('#show-cancelled-orders').attrs['aria-pressed'],'true');assert.equal(app.element('#tracking-content').hidden,false);
   app.element('#show-my-orders').handlers.click();assert.equal(app.element('#customer-order-list').children.length,0);assert.equal(app.element('#tracking-content').hidden,true);
   const page=await readFile(new URL('../../frontend/acompanhar.html',import.meta.url),'utf8');assert(!page.includes('tracking-copy'));
 });
