import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
const source=JSON.parse(await readFile(new URL('../imports/cardapio/catalogo.json',import.meta.url),'utf8'));

test('cardápio das fotos: tamanhos, carnes e preços permanecem distintos',()=>{
  const items=source.cardapio.flatMap(group=>group.itens),map=new Map(items.map(item=>[item.id,item]));
  assert.equal(items.length,71);assert.equal(map.size,71);assert.equal(source.cardapio.length,9);
  for(const [id,price] of [['art-supremo-150',22.9],['art-supremo-300',31.9],['art-costela-cream-150',26.9],['art-costela-cream-300',36.9],['pizza-calabresa-6',31],['pizza-calabresa-8',40],['trad-x-burguer',10],['pastel-carne-queijo',9.99],['coxinha-frango',6.5],['batata-400-costela',30],['extra-cream-cheese',3]])assert.equal(map.get(id).preco,price,id);
  assert.equal(source.cardapio.find(group=>group.id==='pasteis').itens.length,6);
  assert.equal(source.cardapio.find(group=>group.id==='combos').itens.length,3);
  for(const name of ['Fanta','Coca-Cola','Sprite','Skinka'])assert(items.some(item=>item.nome===name+' · lata 350 ml'));
});

test('cardápio: valores do servidor são usados no pedido e combos indefinidos não podem ser enviados',()=>{
  const store=createStore(':memory:',source);
  try{
    store.updateSettings({deliveryFeeCents:0,minimumSubtotalCents:3000,acceptingOrders:true});
    const body={customer:'Cliente Teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'pix',notes:'',items:[{id:'art-supremo-150',qty:1},{id:'trad-x-burguer',qty:1}],expectedTotalCents:3290};
    assert.equal(store.placeOrder(body,randomUUID()).totalCents,3290);
    assert.throws(()=>store.placeOrder({...body,items:[{id:'combo-familia',qty:1}],expectedTotalCents:8990},randomUUID()),/confirmadas/);
  }finally{store.close();}
});

test('produtos arquivados somem do catálogo e não podem ser comprados, preservando pedidos anteriores',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mdl-archive-')),filename=path.join(dir,'loja.sqlite');let store=createStore(filename,source);
  try{
    store.updateSettings({deliveryFeeCents:0,minimumSubtotalCents:3000,acceptingOrders:true});
    const body={customer:'Cliente Teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'pix',notes:'',items:[{id:'art-supremo-150',qty:2}],expectedTotalCents:4580};
    const order=store.placeOrder(body,randomUUID());store.close();
    const db=new DatabaseSync(filename);db.prepare('UPDATE products SET archived=1 WHERE id=?').run('art-supremo-150');db.close();
    store=createStore(filename,source);
    assert(!store.catalog().cardapio.flatMap(group=>group.itens).some(item=>item.id==='art-supremo-150'));
    assert.throws(()=>store.placeOrder(body,randomUUID()),/não está disponível/);
    assert.equal(store.order(order.id).items[0].name,'Supremo · 1 carne (150 g)');assert.equal(store.order(order.id).totalCents,4580);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

 test('pizzas: oito fatias antes de seis, com precos reajustados no pedido',()=>{
   const store=createStore(':memory:',source);
   try{
     store.updateSettings({deliveryFeeCents:0,minimumSubtotalCents:3000,acceptingOrders:true});
     const pizzas=store.catalog().cardapio.find(group=>group.id==='pizzas').itens;
     assert.equal(pizzas.length,14);
     assert(pizzas.slice(0,7).every(item=>item.id.endsWith('-8')));
     assert(pizzas.slice(7).every(item=>item.id.endsWith('-6')));
     const body={customer:'Cliente Teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'pix',notes:'',items:[{id:'pizza-calabresa-8',qty:1},{id:'pizza-calabresa-6',qty:1}],expectedTotalCents:7100};
     assert.equal(store.placeOrder(body,randomUUID()).totalCents,7100);
   }finally{store.close();}
 });

 test('todos os alimentos possuem foto local e descricao alternativa',async()=>{
   const foods=source.cardapio.filter(group=>group.id!=='bebidas').flatMap(group=>group.itens);
   assert.equal(foods.length,57);
   for(const item of foods){assert(item.imagem.startsWith('assets/lanches/'),item.id);assert(item.imagemAlt,item.id);const image=await readFile(new URL('../../frontend/'+item.imagem,import.meta.url));assert(image.length>1000,item.id);}
 });

 test('bebidas: todas as 14 opcoes possuem foto local',async()=>{
   const store=createStore(':memory:',source);
   try{const drinks=store.catalog().cardapio.find(group=>group.id==='bebidas').itens;assert.equal(drinks.length,14);for(const item of drinks){assert(item.imagem,item.id);assert(item.imagemAlt,item.id);assert((await readFile(new URL('../../frontend/'+item.imagem,import.meta.url))).length>1000,item.id);}}
   finally{store.close();}
 });
