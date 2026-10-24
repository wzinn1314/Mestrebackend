const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const normalize=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const field=(value,min,max,label)=>{
  if(typeof value!=='string' || value.trim().length<min || value.trim().length>max || /[\x00-\x1f<>]/.test(value))fail(`Confira ${label}.`);
  return value.trim().replace(/\s+/g,' ');
};
export function addressFields(input){
  if(!input || typeof input!=='object' || Array.isArray(input))fail('Informe CEP, rua, número e bairro da entrega.');
  const cep=field(input.cep,8,9,'o CEP').replace('-','');
  if(!/^\d{8}$/.test(cep))fail('Informe um CEP com 8 dígitos.');
  if(cep!=='56000000')fail('O CEP de entrega é fixo: 56000-000, Salgueiro - PE.');
  const street=field(input.street,3,120,'a rua'),neighborhood=field(input.neighborhood,3,80,'o bairro');
  if((street.match(/[\p{L}]/gu)||[]).length<3 || (neighborhood.match(/[\p{L}]/gu)||[]).length<3)fail('Informe o nome completo da rua e do bairro.');
  const number=field(input.number,1,12,'o número');
  if(!/^(?:\d{1,6}[a-z]?|s\/?n)$/i.test(number))fail('Informe o número do imóvel ou S/N para um endereço sem número.');
  return {cep,street,number,neighborhood,complement:field(input.complement??'',0,100,'o complemento')};
}
export function createAddressService({fetchImpl=fetch,city='Salgueiro',state='PE'}={}){
  const cache=new Map();
  async function lookup(raw){
    if(typeof raw!=='string'||!/^\d{8}$/.test(raw))fail('Informe um CEP com 8 dígitos.');
    if(raw!=='56000000')fail('O CEP de entrega é fixo: 56000-000, Salgueiro - PE.');
    const cached=cache.get(raw);if(cached && cached.expires>Date.now())return cached.data;
    let result;
    try{
      const response=await fetchImpl(`https://viacep.com.br/ws/${raw}/json/`,{signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw Error();result=await response.json();
    }catch{fail('Não foi possível consultar o CEP agora. Tente novamente ou escolha retirada.',503);}
    if(result.erro)fail('CEP não encontrado. Confira os 8 dígitos.',404);
    if(typeof result.localidade!=='string'||typeof result.uf!=='string')fail('Não foi possível validar o CEP. Tente novamente.',503);
    if(normalize(result.localidade)!==normalize(city)||result.uf!==state)fail(`A entrega está disponível apenas em ${city} - ${state}.`,422);
    const data={cep:raw,street:result.logradouro||'',neighborhood:result.bairro||'',city:result.localidade,state:result.uf,level:result.logradouro?'street':'city'};
    if(cache.size>=500)cache.delete(cache.keys().next().value);
    cache.set(raw,{data,expires:Date.now()+6*60*60*1000});return data;
  }
  async function verify(input){
    const details=addressFields(input),record=await lookup(details.cep);
    if(record.street && normalize(details.street)!==normalize(record.street))fail('A rua informada não corresponde ao CEP. Consulte o CEP novamente.');
    if(record.neighborhood && normalize(details.neighborhood)!==normalize(record.neighborhood))fail('O bairro informado não corresponde ao CEP. Consulte o CEP novamente.');
    const street=record.street||details.street,neighborhood=record.neighborhood||details.neighborhood;
    return {cep:details.cep,level:record.level,city:record.city,state:record.state,formatted:`${street}, ${details.number} - ${neighborhood}${details.complement?` - ${details.complement}`:''} - ${record.city}/${record.state} - CEP ${details.cep.slice(0,5)}-${details.cep.slice(5)}`};
  }
  return {lookup,verify};
}
