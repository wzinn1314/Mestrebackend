import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const entrada=await readFile(new URL('../../frontend/js/entrada.js',import.meta.url),'utf8');
const imprimir=(await readFile(new URL('../../frontend/js/api.js',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../../frontend/js/imprimir.js',import.meta.url),'utf8'));
const elements=()=>{
  const nodes=new Map();
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',hidden:false,disabled:false,handlers:{},children:[],addEventListener(name,fn){this.handlers[name]=fn;},setCustomValidity(value){this.invalid=value;},focus(){this.focused=true;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});
    return nodes.get(selector);
  };
  return node;
};

test('entrada: valida e normaliza o nome antes de entrar como cliente',()=>{
  const node=elements(),storage=new Map();let target;
  node('#client-entry-form').reportValidity=()=>!node('#entry-name').invalid;
  vm.runInNewContext(entrada,{document:{querySelector:node},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},location:{hash:'#cliente',search:''},URLSearchParams,window:{location:{assign:url=>{target=url;}}}});
  assert.equal(node('#entry-name').focused,true);
  node('#entry-name').value='   ';node('#client-entry-form').handlers.submit({preventDefault(){}});
  assert.equal(target,undefined);assert.equal(storage.size,0);
  node('#entry-name').value='  Ana   Lima  ';node('#client-entry-form').handlers.submit({preventDefault(){}});
  assert.equal(storage.get('mdl-customer-name'),'Ana Lima');assert.equal(target,'pedidos.html');
});

test('entrada: falha de armazenamento informa o problema sem perder a validação',()=>{
  const node=elements();let redirected=false;
  node('#client-entry-form').reportValidity=()=>true;
  vm.runInNewContext(entrada,{document:{querySelector:node},sessionStorage:{getItem(){throw Error();},setItem(){throw Error();}},location:{hash:'',search:''},URLSearchParams,window:{location:{assign(){redirected=true;}}}});
  node('#entry-name').value='Ana';node('#client-entry-form').handlers.submit({preventDefault(){}});
  assert.equal(redirected,false);assert.match(node('#entry-error').textContent,/Não foi possível guardar/);
});

async function printClient({authorized=true,auto=false,paymentMethod='cartao',needsChange=null,changeForCents=null,status='confirmado',persistedStorage}={}){
  const node=elements(),storage=persistedStorage || new Map();let printed=0;
  node('#print-order').disabled=true;
  const order={id:'1a052fe9-f6a6-4c28-bd45-f7490bb07ac4',code:'ABCD12',customer:'Ana Lima',phone:'87999999999',fulfillment:'entrega',paymentMethod,needsChange,changeForCents,address:'Rua de teste 100',notes:'Sem cebola <não é HTML>',items:[{name:'Item do teste',qty:2,unitPriceCents:1500}],subtotalCents:3000,deliveryFeeCents:0,totalCents:3000,status,createdAt:'2026-10-23T22:00:00Z'};
  const document={querySelector:node,body:{dataset:{}},createElement:()=>node(Symbol())};
  await vm.runInNewContext(imprimir,{document,location:{hash:'#'+order.id,search:auto?'?auto=1':''},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:async url=>{assert.equal(url,'/api/admin/orders/'+order.id);return{ok:authorized,status:authorized?200:401,json:async()=>authorized?order:{error:'Não autorizado'}};},window:{print(){printed++;}},URLSearchParams});
  return {node,document,storage,get printed(){return printed;}};
}

test('impressão: comprovante com dados reais, papel 58/80 mm e impressão acionada pelo usuário',async()=>{
  const app=await printClient();
  assert.equal(app.document.body.dataset.paper,'58');
  assert.equal(app.node('#receipt-name').textContent,'Ana Lima');
  assert.equal(app.node('#receipt-notes').textContent,'Sem cebola <não é HTML>');
  assert.equal(app.node('#receipt-total').textContent,'R$\u00a030,00');
  assert.equal(app.node('#receipt-delivery').textContent,'Grátis');
  assert.equal(app.node('#receipt-payment').textContent,'Cartão no ato da entrega');
  assert.equal(app.node('#print-order').disabled,false);assert.equal(app.printed,0);
  app.node('#paper-width').handlers.change({target:{value:'80'}});
  assert.equal(app.document.body.dataset.paper,'80');assert.equal(app.storage.get('mdl-receipt-width'),'80');
  app.node('#print-order').handlers.click();assert.equal(app.printed,1);
});

test('impressão: sessão de empresa é obrigatória para carregar e imprimir os dados',async()=>{
  const app=await printClient({authorized:false});
  assert.equal(app.node('#print-order').disabled,true);
  assert.match(app.node('#print-message').textContent,/Entre como empresa/);
  app.node('#print-order').handlers.click();assert.equal(app.printed,0);
});

 test('painel: exige senha novamente mesmo quando existe uma sessao anterior',async()=>{
   const source=await readFile(new URL('../../frontend/js/painel.js',import.meta.url),'utf8');
   const node=elements(),requests=[];node('#order-detail').close=()=>{};
   vm.runInNewContext(source,{document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},window:{MDLHttp:{readJson:response=>response.json()}},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,status:200,json:async()=>url==='/api/admin/session'?{authenticated:true,needsSetup:false}:{ok:true}};},setInterval(){},Intl});
   await new Promise(resolve=>setImmediate(resolve));
   assert.deepEqual(requests.map(item=>item.url),['/api/admin/session','/api/admin/logout']);
   assert.equal(node('#admin-content').hidden,true);assert.equal(node('#login-section').hidden,false);
   assert.equal(node('#admin-password').autocomplete,'current-password');
 });

 test('nota: inclui dinheiro, valor recebido e valor do troco; imprime uma vez ao confirmar',async()=>{
   const app=await printClient({auto:true,paymentMethod:'dinheiro',needsChange:true,changeForCents:5000});
   assert.equal(app.printed,1);
   const refreshed=await printClient({auto:true,persistedStorage:app.storage});assert.equal(refreshed.printed,0);
   assert.match(app.node('#receipt-change').textContent,/50,00.*20,00/);
   assert.match(app.node('#receipt-payment').textContent,/entrega/);
   const pending=await printClient({auto:true,status:'novo'});assert.equal(pending.printed,0);
   const pix=await printClient({paymentMethod:'pix'});assert.equal(pix.node('#receipt-payment').textContent,'Pix no ato da entrega');
   const exact=await printClient({paymentMethod:'dinheiro',needsChange:false});assert.match(exact.node('#receipt-change').textContent,/precisa de troco/);
 });
