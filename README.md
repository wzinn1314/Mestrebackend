# MestredoslanchesBackend

API do Mestre dos Lanches para catálogo, pedidos, autenticação da empresa, acompanhamento e atualização dos status. Node.js 24 ou superior e SQLite local, sem dependências npm externas.

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
- `MDL_ADMIN_PASSWORD`: define o primeiro acesso somente quando o banco ainda não possui administrador. O provisionamento atual exige pelo menos 12 caracteres. Alterar esta variável não troca uma senha já cadastrada.

Não publique `.env`, banco, backups, sessões ou senhas. O banco deste computador e a senha da loja não fazem parte deste repositório.

## Frontend e API

As chamadas do frontend usam caminhos `/api/` na mesma origem. O código atual não oferece CORS para um frontend em outro domínio. Configure o servidor/proxy para manter as telas e `/api/` na mesma origem ou adapte a integração antes da publicação.

Os testes de telas e os scripts de imagens/cardápio também utilizam a pasta irmã `frontend`:

```sh
npm test
```

## Antes de operar na internet

Use HTTPS e armazenamento permanente para `data/`, com backup externo e restauração testada. A publicação do código não resolve as pendências de produção identificadas na revisão: limite de requisições atrás de proxy, recuperação de acompanhamento quando o navegador não salva dados, política de provisionamento da senha e validação de notificações e impressão na máquina do restaurante.
