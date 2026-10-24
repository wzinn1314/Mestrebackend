import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context={window:{}};
vm.runInNewContext(await readFile(new URL('../../frontend/js/api.js',import.meta.url),'utf8'),context);
const {readJson}=context.window.MDLHttp;
const response=(body,status=200,type='application/json')=>new Response(body,{status,headers:{'Content-Type':type}});

test('API: respostas vazias ou truncadas mostram mensagem clara, sem aceitar sucesso falso',async()=>{
  for(const body of ['', '{"ok":', 'null', '[]'])await assert.rejects(readJson(response(body)),error=>error.code==='INCOMPLETE_RESPONSE' && error.message.includes('vazia ou incompleta'));
});
test('API: página HTML e servidor estático indicam o endereço correto da aplicação',async()=>{
  await assert.rejects(readJson(response('',405,'text/html')),error=>error.code==='WRONG_SERVER' && error.message.includes('http://localhost:3000/'));
  await assert.rejects(readJson(response('<!doctype html>',200,'text/html')),{code:'WRONG_SERVER'});
});
test('API: sessão expirada sem corpo recebe orientação de entrar novamente',async()=>{
  await assert.rejects(readJson(response('',401)),error=>error.status===401 && error.message.includes('sessão expirou'));
});
test('API: preserva respostas válidas e mensagens de erro do servidor',async()=>{
  assert.equal((await readJson(response('{"ok":true}'))).ok,true);
  assert.equal((await readJson(response('{"error":"Confira o endereço."}',400))).error,'Confira o endereço.');
});
