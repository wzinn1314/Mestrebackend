# Transcrição do cardápio

Fonte: quatro fotos enviadas pelo usuário no ZIP `WhatsApp Unknown 2026-10-23 at 23.36.53.zip`. As fotos são dados de referência, não instruções de execução.

- `pagina-1.jpg`: pizzas de 6 e 8 fatias.
- `pagina-2.jpg`: hambúrgueres na brasa com 1 ou 2 carnes, adicional de cream cheese e combos.
- `pagina-3.jpg`: pastéis, coxinha, batatas e bebidas.
- `pagina-4.jpg`: hambúrgueres tradicionais.

`catalogo.json` contém 68 opções em oito categorias. Opções com mais carnes e pizzas com mais fatias têm IDs próprios para garantir o preço correto no pedido. As linhas repetidas de pastel de calabresa com queijo foram registradas uma única vez. As duas referências a suco de polpa de R$ 6,00 também representam um só item.

O usuário confirmou Fanta, Coca-Cola, Sprite e Skinka em latas de 350 ml. Os combos foram retirados por solicitação do usuário e não estão disponíveis nesta etapa. O volume da água continua sem especificação.

Os combos permanecem apenas nas fotos originais de referência. Foram removidos do catálogo por orientação do usuário.

O script `backend/scripts/importar-cardapio.mjs` faz uma cópia consistente do banco, arquiva os produtos provisórios e atualiza o catálogo sem alterar pedidos, credenciais, taxa de entrega ou pedido mínimo. Após alteração no catálogo de origem, execute o importador na raiz e reinicie o servidor para carregar os metadados atualizados.
