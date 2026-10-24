import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const catalog={cardapio:[{id:'lanches',nome:'Lanches',itens:[{id:'lanches-0',nome:'Produto de teste',desc:'Apenas para o teste',preco:19.9,ativo:true}]}],deliveryFeeCents:500,minimumSubtotalCents:1000,acceptingOrders:true};
const source=(await readFile(new URL('../../frontend/js/api.js',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../../frontend/js/historico-pedidos.js',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../../frontend/js/pedidos.js',import.meta.url),'utf8'));
async function client(config=catalog,{failFirst=false,emptyFirst=false,customerName='Cliente Teste',savedStorage}={}){
  const nodes=new Map(),storage=new Map(savedStorage),requests=[],timers=new Map();let counter=0,target;
  if(customerName!==null)storage.set('mdl-customer-name',customerName);
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,hidden:false,required:false,handlers:{},classList:{toggle(){}},setAttribute(){},setCustomValidity(value){this.validityMessage=value;},reportValidity(){return true;},addEventListener(name,fn){this.handlers[name]=fn;},querySelectorAll(){return [];},focus(){},scrollIntoView(){},showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(id);
  };
  const storageApi={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const context={window:{MDL:{cardapio:config.cardapio},matchMedia:()=>({matches:false}),location:{assign:url=>{target=url;},replace:url=>{target=url;}}},document:{querySelector:element,querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}}},localStorage:storageApi,sessionStorage:storageApi,crypto:{randomUUID},AbortController,setInterval:()=>{},setTimeout:fn=>{timers.set(++counter,fn);return counter;},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{
    if(url==='/api/catalog')return{ok:true,json:async()=>config};
    if(url.startsWith('/api/address/'))return{ok:true,json:async()=>({cep:'56000000',city:'Salgueiro',state:'PE',street:'',neighborhood:'',level:'city'})};
    requests.push({url,options});
    if(failFirst && requests.length===1)throw new TypeError('Failed to fetch');
    if(emptyFirst && requests.length===1)return{ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected end of JSON input');}};
    return {ok:true,json:async()=>({id:'1a052fe9-f6a6-4c28-bd45-f7490bb07ac4',trackingToken:'a'.repeat(43)})};
  }};
  element('[name="fulfillment"]:checked').value='retirada';
  element('[name="payment-method"]:checked').value='pix';
  element('#needs-change').value='nao';
  await vm.runInNewContext(source,context);
  const add=()=>element('#catalog').handlers.click({target:{closest:()=>({dataset:{add:'lanches-0'}})}});
  const submit=()=>element('#checkout-form').handlers.submit({preventDefault(){}});
  function fill(){element('#customer-name').value='Cliente Teste';element('#customer-phone').value='87999999999';element('#order-notes').value='';element('#delivery-address').value='';}
  return {element,add,submit,fill,requests,storage,get target(){return target;}};
}

test('checkout: envia itens e total, recebe protocolo e abre acompanhamento',async()=>{
  const app=await client();app.add();app.add();app.fill();
  assert.match(app.element('#customer-greeting').textContent,/Cliente Teste/);
  app.element('#review-order').handlers.click();
  assert.equal(app.element('#checkout-total').textContent,'R$\u00a039,80');
  assert.equal(app.element('#checkout-submit').disabled,false);
  await app.submit();
  const request=app.requests[0],body=JSON.parse(request.options.body);
  assert.deepEqual(body.items,[{id:'lanches-0',qty:2}]);
  assert.equal(body.expectedTotalCents,3980);assert.equal(body.fulfillment,'retirada');
  assert.equal(body.paymentMethod,'pix');
  assert.equal(app.target,'acompanhar.html');
  assert.equal(JSON.parse(app.storage.get('mdl-last-order')).id,'1a052fe9-f6a6-4c28-bd45-f7490bb07ac4');
  assert.equal(JSON.parse(app.storage.get('mdl-order-history')).length,1);
});

test('cliente: exige entrada com nome antes de abrir o cardápio',async()=>{
  const app=await client(catalog,{customerName:null});
  assert.equal(app.target,'index.html?entrada=cliente');
  assert.equal(app.requests.length,0);
});

test('checkout: consulta o CEP e envia endereço de entrega com campos separados',async()=>{
  const app=await client();app.add();app.fill();app.element('[name="fulfillment"]:checked').value='entrega';
  assert.equal(app.element('#delivery-cep').value,'56000-000');assert.equal(app.element('#delivery-cep').readOnly,true);
  for(const [selector,value] of Object.entries({'#delivery-cep':'56000-000','#delivery-address':'Rua José Adalberto','#delivery-number':'194','#delivery-neighborhood':'Santa Margarida','#delivery-complement':'Casa'}))app.element(selector).value=value;
  app.element('#review-order').handlers.click();await app.submit();
  const body=JSON.parse(app.requests[0].options.body);
  assert.equal(body.deliveryAddress.cep,'56000000');assert.equal(body.deliveryAddress.street,'Rua José Adalberto');assert.equal(body.deliveryAddress.number,'194');
  assert.match(app.element('#address-message').textContent,/precisará conferir a rua/);
});

test('checkout: envia cartão ou dinheiro conforme a escolha e exige uma opção válida',async()=>{
  for(const method of ['cartao','dinheiro']){
    const app=await client();app.add();app.fill();app.element('[name="payment-method"]:checked').value=method;app.element('#review-order').handlers.click();await app.submit();
    assert.equal(JSON.parse(app.requests[0].options.body).paymentMethod,method);
  }
  const app=await client();app.add();app.fill();app.element('[name="payment-method"]:checked').value='';app.element('#review-order').handlers.click();await app.submit();
  assert.equal(app.requests.length,0);assert.match(app.element('#checkout-error').textContent,/Selecione a forma de pagamento/);
});

test('checkout: nova tentativa de envio usa a mesma chave após falha de conexão',async()=>{
  const app=await client(catalog,{failFirst:true});app.add();app.fill();app.element('#review-order').handlers.click();
  await app.submit();assert.equal(app.target,undefined);assert.match(app.element('#checkout-error').textContent,/não será duplicada/);
  await app.submit();
  assert.equal(app.requests[0].options.headers['Idempotency-Key'],app.requests[1].options.headers['Idempotency-Key']);
  assert.equal(app.target,'acompanhar.html');
});

test('checkout: resposta vazia mantém a sacola e permite reenviar sem duplicação',async()=>{
  const app=await client(catalog,{emptyFirst:true});app.add();app.fill();app.element('#review-order').handlers.click();
  await app.submit();assert.equal(app.target,undefined);assert.match(app.element('#checkout-error').textContent,/vazia ou incompleta/);assert.equal(app.element('#cart-count').textContent,'1 item');
  await app.submit();assert.equal(app.requests[0].options.headers['Idempotency-Key'],app.requests[1].options.headers['Idempotency-Key']);assert.match(app.target,/acompanhar/);
});

test('checkout: impede envio sem preço confirmado e mantém sacola',async()=>{
  const config=structuredClone(catalog);config.cardapio[0].itens[0].preco=null;
  const app=await client(config);app.add();app.fill();app.element('#review-order').handlers.click();
  assert.equal(app.element('#checkout-submit').disabled,true);await app.submit();
  assert.equal(app.requests.length,0);assert.equal(app.element('#cart-count').textContent,'1 item');
});

test('checkout: bloqueia pedido abaixo do mínimo e mostra entrega grátis',async()=>{
  const config=structuredClone(catalog);config.deliveryFeeCents=0;config.minimumSubtotalCents=2500;
  const app=await client(config);app.add();app.fill();app.element('#review-order').handlers.click();
  assert.equal(app.element('#checkout-submit').disabled,true);
  assert.equal(app.element('#cart-delivery').textContent,'Grátis');
  assert.match(app.element('#cart-minimum').textContent,/Faltam/);
  await app.submit();assert.equal(app.requests.length,0);
  app.add();app.element('#review-order').handlers.click();
  assert.equal(app.element('#checkout-submit').disabled,false);
  await app.submit();assert.equal(JSON.parse(app.requests[0].options.body).expectedTotalCents,3980);
});

 test('sacola: libera continuar em R$30 e bloqueia novamente ao remover item',async()=>{
   const config=structuredClone(catalog);config.minimumSubtotalCents=3000;config.cardapio[0].itens[0].preco=15;
   const app=await client(config);
   assert.equal(app.element('#review-order').disabled,true);
   app.add();assert.equal(app.element('#review-order').disabled,true);
   app.add();assert.equal(app.element('#review-order').disabled,false);
   app.element('#cart-items').handlers.click({target:{closest:selector=>selector==='button'?{dataset:{change:'lanches-0',step:'-1'}}:null}});
   assert.equal(app.element('#review-order').disabled,true);
 });

 test('checkout: solicita troco para dinheiro e envia o valor em centavos',async()=>{
   const app=await client();app.add();app.fill();app.element('[name="payment-method"]:checked').value='dinheiro';app.element('#needs-change').value='sim';app.element('#review-order').handlers.click();
   app.element('#change-for').value='10';await app.submit();assert.equal(app.requests.length,0);
   app.element('#change-for').value='50';await app.submit();const body=JSON.parse(app.requests[0].options.body);assert.equal(body.needsChange,true);assert.equal(body.changeForCents,5000);
 });

 test('cache do cliente: restaura nome, contato, endereco e sacola ao voltar ao cardapio',async()=>{
   const app=await client();app.add();app.fill();app.element('#delivery-address').value='Rua Jose Adalberto';app.element('#delivery-number').value='194';app.element('#delivery-neighborhood').value='Santa Margarida';app.element('#checkout-form').handlers.input();
   assert(app.storage.has('mdl-customer-details-v1'));
   const restored=await client(catalog,{customerName:null,savedStorage:app.storage});
   assert.equal(restored.element('#customer-phone').value,'87999999999');assert.equal(restored.element('#delivery-address').value,'Rua Jose Adalberto');assert.equal(restored.element('#delivery-number').value,'194');assert.equal(restored.element('#cart-count').textContent,'1 item');assert.equal(restored.target,undefined);
 });
