import test from 'node:test';
import assert from 'node:assert/strict';
import { addressFields,createAddressService } from '../lib/address.mjs';

const input={cep:'56000-000',street:'Rua José Adalberto',number:'194',neighborhood:'Santa Margarida',complement:'Casa'};
const record={localidade:'Salgueiro',uf:'PE',logradouro:'',bairro:''};
const service=data=>createAddressService({fetchImpl:async()=>({ok:true,json:async()=>data})});

test('endereço: exige CEP, rua, número e bairro estruturados',()=>{
  assert.equal(addressFields(input).cep,'56000000');
  for(const patch of [{cep:'123'},{cep:'01001000'},{street:'1234'},{number:''},{number:'qualquer'},{neighborhood:'12'},{street:'<script>'}])assert.throws(()=>addressFields({...input,...patch}),{status:400});
  assert.equal(addressFields({...input,number:'S/N'}).number,'S/N');
});
test('CEP geral: confirma cidade e sinaliza que não confirmou a rua',async()=>{
  const result=await service(record).verify(input);
  assert.equal(result.level,'city');assert.equal(result.city,'Salgueiro');assert.match(result.formatted,/194/);assert.match(result.formatted,/56000-000/);
});
test('CEP de rua: confere logradouro e bairro, bloqueando alterações indevidas',async()=>{
  const lookup=service({...record,logradouro:'Rua José Adalberto',bairro:'Santa Margarida'});
  assert.equal((await lookup.verify(input)).level,'street');
  await assert.rejects(lookup.verify({...input,street:'Rua diferente'}),/rua informada não corresponde/);
  await assert.rejects(lookup.verify({...input,neighborhood:'Outro bairro'}),/bairro informado não corresponde/);
});
test('endereço: bloqueia CEP inexistente, fora da cidade e indisponibilidade do serviço',async()=>{
  await assert.rejects(service({erro:true}).verify(input),{status:404});
  await assert.rejects(service({...record,localidade:'Recife'}).verify(input),{status:422});
  const unavailable=createAddressService({fetchImpl:async()=>{throw Error('offline');}});
  await assert.rejects(unavailable.verify(input),{status:503});
  await assert.rejects(service(record).lookup('123'),{status:400});
  await assert.rejects(service(record).lookup('01001000'),/CEP de entrega é fixo/);
});
test('consulta: envia apenas o CEP ao provedor e reaproveita a consulta',async()=>{
  const urls=[];
  const lookup=createAddressService({fetchImpl:async url=>{urls.push(url);return{ok:true,json:async()=>record};}});
  await lookup.verify(input);await lookup.verify({...input,number:'20'});
  assert.deepEqual(urls,['https://viacep.com.br/ws/56000000/json/']);
});
