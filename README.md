# MestredoslanchesBackend

PostgreSQL local instalado e integração Vercel: consulte [POSTGRESQL.md](POSTGRESQL.md). Use `DATABASE_PROVIDER=postgres` e `DATABASE_URL` para selecionar este banco.

Para o projeto Firebase `mestredoslanches`, siga [a configuração do Cloud Firestore](FIREBASE.md). Selecione `DATABASE_PROVIDER=firestore`; as instruções de Turso abaixo são apenas para o provedor anterior.

API do Mestre dos Lanches para catálogo, pedidos, autenticação da empresa, acompanhamento e atualização dos status. Node.js 24. Em uso local, mantém SQLite em arquivo. No Vercel, usa Turso/libSQL externo por meio de `@libsql/client`.

## Executar

Na raiz deste repositório:

```sh
npm start
```

O endereço padrão é `http://localhost:3000`. O banco é criado em `data/loja.sqlite`, pasta privada ignorada pelo Git. O catálogo inicial fica em `config/loja.json`.

O frontend é mantido separadamente em https://github.com/wzinn1314/Mestredoslanches. Para executar os dois projetos localmente com o servidor atual, mantenha os clones em pastas irmãs chamadas `backend` e `frontend`. O servidor busca os arquivos estáticos em `../frontend`.

## Configuração

O servidor lê as variáveis do processo. `.env.example` é somente um modelo, sem senha real. Se usar um arquivo `.env`, carregue-o explicitamente com `node --env-file=.env server.mjs`.

- `HOST`: endereço de escuta; padrão `127.0.0.1`.
- `PORT`: porta; padrão `3000`.
- `PUBLIC_ORIGIN`: endereço público completo, como a origem HTTPS configurada na hospedagem. Obrigatório ao escutar fora do computador local.
- `MDL_ADMIN_PASSWORD`: define o primeiro acesso somente quando o banco ainda não possui administrador. Aceita senha numérica de 8 dígitos ou senha com pelo menos 12 caracteres. Alterar esta variável não troca uma senha já cadastrada.

Não publique `.env`, banco, backups, sessões ou senhas. O banco deste computador e a senha da loja não fazem parte deste repositório.

## Frontend e API

As chamadas do frontend usam caminhos `/api/` na mesma origem. O código atual não oferece CORS para um frontend em outro domínio. Configure o servidor/proxy para manter as telas e `/api/` na mesma origem ou adapte a integração antes da publicação.

Os testes de telas e os scripts de imagens/cardápio também utilizam a pasta irmã `frontend`:

```sh
npm test
```

## Frontend e backend no Vercel

1. Crie um banco na sua conta [Turso](https://app.turso.tech/) e obtenha a URL `libsql://...` e um token de acesso. Esses valores não devem ser enviados ao GitHub.
2. Importe o repositório do frontend no Vercel, com preset **Other**, sem comando de build e sem pasta de saída personalizada. O `vercel.json` do frontend encaminha `/api/` para `https://mestredoslanchesbackend.vercel.app`.
3. No projeto do backend no Vercel, use preset **Other**, Node.js **24.x**, sem comando de build e sem pasta de saída personalizada. Mantenha `vercel.json` e a função `api/index.mjs` na raiz do repositório.
4. Em **Settings → Environment Variables**, configure as variáveis abaixo para Production. Depois faça um novo deploy:
   - `TURSO_DATABASE_URL`: URL do banco criado.
   - `TURSO_AUTH_TOKEN`: token privado do banco.
   - `PUBLIC_ORIGIN`: endereço HTTPS exato do frontend, sem barra no final.
   - `API_ORIGIN`: `https://mestredoslanchesbackend.vercel.app`.
   - `MDL_ADMIN_PASSWORD`: senha que será usada no primeiro acesso da empresa. Não fica no repositório; somente seu hash é salvo no banco.
5. Abra `/api/health` no backend. Depois da configuração e conexão com o banco, deve retornar `{"ok":true,"service":"Mestre dos Lanches API"}`. Abra também `/api/health` no endereço do frontend para conferir o encaminhamento.
6. Teste, pelo frontend, o login da empresa, um pedido, seu acompanhamento, cancelamento, troco, notificação e comprovante.

O primeiro acesso cria as tabelas e o catálogo no banco externo. Não usa arquivos temporários para guardar pedidos. Sem as variáveis obrigatórias, responde HTTP 503 com `CONFIGURATION_REQUIRED`, listando somente os nomes das variáveis ausentes. Problemas de conexão também retornam uma mensagem controlada; consulte os logs da função.

O banco local não é apagado nem transferido automaticamente: se precisar manter os pedidos e os acessos existentes, planeje sua migração antes de começar a usar o banco externo. Cada ambiente de Preview deve usar banco e origem próprios para não alterar dados de Production.

Os limites de requisições ficam no banco externo, compartilhados entre instâncias. Cabeçalhos de IP encaminhado são usados somente no adaptador executado no Vercel; no servidor local são ignorados.

## Antes de operar na internet

Use HTTPS e armazenamento permanente para `data/`, com backup externo e restauração testada. A publicação do código não resolve as pendências de produção identificadas na revisão: recuperação de acompanhamento quando o navegador não salva dados e validação de notificações e impressão na máquina do restaurante.
