# PostgreSQL

O backend aceita `DATABASE_PROVIDER=postgres` e `DATABASE_URL`. Mantém validação de preços no servidor, pedido mínimo, entrega grátis, troco, autenticação por hash, acompanhamento privado e versões de status. As escritas usam transações em uma conexão e um bloqueio transacional para impedir duplicação entre instâncias. O pool abre no máximo três conexões por instância.

## Instalação local preparada neste computador

PostgreSQL 17.11, pacote oficial EDB, foi extraído em `data/postgres/runtime/pgsql`. O cluster privado está em `data/postgres/cluster`, escutando somente `127.0.0.1:54329`. Nada foi instalado como serviço global do Windows. Binários, dados, logs, backups e credenciais são ignorados pelo Git.

Para iniciar o banco, execute na pasta backend:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-postgres.ps1
```

Em seguida inicie o site e API:

```powershell
node --env-file=.env.postgres.local server.mjs
```

Abra `http://localhost:43080`. A porta 3000 já estava ocupada, então esta instância usa 3001. O frontend é servido da pasta irmã `frontend`. A senha PostgreSQL aleatória fica em `.env.postgres.local`; não é a senha da empresa, cujo hash foi migrado. Não publique este arquivo.

O script de setup é reutilizável; requer o pacote PostgreSQL já extraído e não reinicializa um cluster existente. Para parar o banco:

```powershell
& .\data\postgres\runtime\pgsql\bin\pg_ctl.exe -D .\data\postgres\cluster -w stop
```

## Migração

```powershell
node --env-file=.env.postgres.local scripts/migrate-sqlite-postgres.mjs
```

O script faz backup consistente do SQLite, preserva produtos na ordem original, configurações, hash/salt do administrador, sessões, pedidos, tokens, pagamentos, troco, endereço e histórico. Copia tudo em uma transação e verifica contagens. Recusa destino que já possui administrador, sessões ou pedidos. Não deve ser executado outra vez contra o banco já migrado. Os dados de outros bancos externos não são acessíveis nem migrados sem a conexão correspondente.

## Vercel

Um banco rodando em `localhost` neste computador não é acessível ao Vercel. Para publicar, crie PostgreSQL hospedado, por exemplo na integração Neon do Marketplace Vercel, e configure no projeto do backend:

- `DATABASE_PROVIDER=postgres`
- `DATABASE_URL`: conexão do banco hospedado com TLS, fornecida pelo provedor. Prefira a conexão com pool para ambiente serverless.
- `PUBLIC_ORIGIN=https://mestredoslanches.vercel.app`
- `API_ORIGIN=https://mestredoslanchesbackend.vercel.app`
- `MDL_ADMIN_PASSWORD`: senha inicial, para um banco novo. Não muda a senha já existente.

Não desative validação TLS. Nunca envie DATABASE_URL ao GitHub ou ao frontend. O primeiro início cria esquema e catálogo; pedidos locais não são transferidos automaticamente. O script de migração pode ser executado deste computador apontando para um destino novo hospedado para transferir os dados preservados.

Resolva o bloqueio de autoria do Vercel antes de publicar e verifique `/api/health` no backend e no frontend. A troca do banco não remove bloqueios de autorização do Vercel.

## Testes

`node --test tests/*.test.mjs` executa a suíte. Para integração real, configure `TEST_POSTGRES_URL` em um ambiente de desenvolvimento e execute `node --test tests/postgres.test.mjs`. O teste cria e remove somente um schema isolado `mdl_test_…`, sem usar tabelas da loja.
