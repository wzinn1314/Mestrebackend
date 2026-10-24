# Firestore no Vercel

Projeto Firebase: `mestredoslanches`. Use o banco Cloud Firestore padrão `(default)`.

## Credencial do backend

No Firebase, abra **Configurações do projeto → Contas de serviço → Gerar nova chave privada**. Guarde o JSON somente no seu computador. Não envie o arquivo ao chat, GitHub ou frontend.

No projeto **do backend** no Vercel, em **Settings → Environment Variables**, configure para Production:

- `DATABASE_PROVIDER`: `firestore`
- `FIREBASE_PROJECT_ID`: `mestredoslanches`
- `FIREBASE_CLIENT_EMAIL`: valor de `client_email` do JSON.
- `FIREBASE_PRIVATE_KEY`: valor completo de `private_key` do JSON, incluindo BEGIN/END PRIVATE KEY. Aceita quebras de linha reais ou `\n`.
- `PUBLIC_ORIGIN`: `https://mestredoslanches.vercel.app`
- `API_ORIGIN`: `https://mestrebackend.vercel.app`
- `MDL_ADMIN_PASSWORD`: senha do primeiro acesso da empresa; 8 números ou pelo menos 12 caracteres. Somente o hash é salvo no banco. Alterar esta variável depois não altera a senha já cadastrada.

Não é necessário configurar variáveis Turso ao selecionar Firestore. O `firebaseConfig` do aplicativo Web não substitui a credencial administrativa e não é necessário nesta integração.

## Regras e publicação

No Firebase → Firestore Database → Regras, publique o conteúdo de `firestore.rules`. Ele bloqueia acesso direto pelo navegador. O backend usa Firebase Admin com as permissões da conta de serviço. Estas regras são para um projeto dedicado a esta loja; não substitua regras de outros aplicativos sem avaliar o impacto.

Faça um novo deploy do backend. O bloqueio de autoria do Vercel deve ser resolvido conectando a conta GitHub do dono do projeto antes da publicação.

O primeiro início cria `mdl_settings`, `mdl_products` e o administrador em `mdl_private`. Pedidos, sessões e limites são gravados em coleções próprias. Pedidos e alterações de status usam transações. Reenvios com a mesma chave retornam o mesmo pedido. O cliente acompanha somente usando o token privado de seu pedido; não recebe dados pessoais de outros clientes.

## Verificação

1. Abra `https://mestrebackend.vercel.app/api/health` e confirme `ok: true`.
2. Confira o mesmo caminho `/api/health` no frontend.
3. Entre como empresa, envie um pedido pelo cliente e atualize o status no painel. Recarregue a tela do cliente e confira o acompanhamento.
4. Confira total, troco, cancelamento e comprovante.

Sem credenciais, a API retorna 503 `CONFIGURATION_REQUIRED`, sem expor seus valores. Falhas de autenticação/conexão aparecem nos logs privados do backend. Não existe migração automática do SQLite/Turso: esta integração começa com os dados do Firestore e o catálogo do repositório. Mantenha o banco anterior preservado.

Sessões e limites possuem expiração lógica, mas seus documentos não são apagados automaticamente. Acompanhe o uso e as cotas do Firebase antes de operar a loja.
