import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../frontend/js/avisos.js',import.meta.url),'utf8');
test('avisos: um som e uma notificação por pedido novo, sem repetir no polling ou em outra aba',()=>{
  const storage=new Map(),notifications=[];let tones=0;
  function tab(){
    const nodes=new Map();const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',addEventListener(){}});return nodes.get(selector);};
    class Audio{currentTime=0;destination={};resume(){return Promise.resolve();}createOscillator(){return {frequency:{},connect(){},start(){tones++;},stop(){}};}createGain(){return {connect(){},gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}}};}}
    class Notification{static permission='granted';constructor(title,options){notifications.push(options);}}
    const window={AudioContext:Audio,Notification};
    vm.runInNewContext(source,{window,document:{querySelector:node},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});
    window.MDLAlerts.armSound();return window.MDLAlerts;
  }
  const a=tab(),b=tab(),old={id:'old',code:'OLD',status:'novo'},fresh={id:'new',code:'NEW',status:'novo'};
  a.ingest([old]);b.ingest([old]);assert.equal(tones,3);assert.equal(notifications.length,1);
  a.ingest([fresh,old]);a.ingest([fresh,old]);b.ingest([fresh,old]);
  assert.equal(tones,6);assert.equal(notifications.length,2);assert.equal(notifications[1].tag,'pedido-new');
});

test('avisos: pedido recebido antes de ativar aparece e notifica após permitir acesso',async()=>{
  const nodes=new Map(),storage=new Map(),notifications=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',addEventListener(){}});return nodes.get(id);};
  class Notification{
    static permission='default';
    static async requestPermission(){this.permission='granted';return 'granted';}
    constructor(title,options){notifications.push(options);}
  }
  const window={Notification};
  vm.runInNewContext(source,{window,document:{querySelector:node},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});
  const order={id:'waiting',code:'WAIT',status:'novo'};
  window.MDLAlerts.ingest([order]);
  assert.match(node('#new-order-notice').textContent,/#WAIT/);assert.equal(notifications.length,0);
  await window.MDLAlerts.enable();
  assert.equal(notifications.length,1);
  window.MDLAlerts.ingest([order]);assert.equal(notifications.length,1);
  window.MDLAlerts.ingest([{...order,status:'preparando'}]);assert.equal(node('#new-order-notice').textContent,'');
});
