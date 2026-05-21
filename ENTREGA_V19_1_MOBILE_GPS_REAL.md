# JM Guinchos V19.1 — Mobile real, GPS celular no mapa e minimização segura

## Correções principais

- Corrigida a acentuação quebrada/encoding nos arquivos principais.
- Padronizada a versão de cache/PWA para `jm-v19-3-provas-minimizacao-definitiva`.
- Refeito o comportamento mobile: bottom navigation, topbar fixa, cards e tabelas adaptadas, mapa com altura controlada, botões grandes e sem estouro lateral.
- Substituída a minimização global frágil por minimização segura, sem mover o conteúdo dos painéis e sem quebrar mapa/formulários.
- O GPS do celular do motorista agora salva no chamado e também tenta atualizar o veículo/frota, permitindo aparecer no mapa do gestor como `GPS celular motorista`.
- O mapa também faz fallback: se o Firestore ainda não permitir atualizar o documento do veículo, ele usa a localização do celular salva no chamado para mostrar a frota/chamado no mapa.
- A central operacional agora considera posição de tracker ou celular para frota online.

## Arquivos alterados

- `index.html`
- `jm.html`
- `motorista.html`
- `superadmin.html`
- `css/style.css`
- `js/app.js`
- `js/mapa.js`
- `js/motorista.js`
- `js/utils.js`
- `firestore.rules`
- `service-worker.js`

## Importante

Para o GPS do celular também atualizar o documento do veículo em `vehicles/{id}`, publique o `firestore.rules` desta versão no Firebase Console. Se não publicar, o sistema ainda salva a localização no chamado e tenta exibir no mapa pelo fallback, mas o ideal é publicar as regras.

## Teste rápido

1. Subir os arquivos no GitHub.
2. Publicar `firestore.rules` no Firebase Console.
3. Abrir:
   - `jm.html?v=jm-v19-3-provas-minimizacao-definitiva`
   - `motorista.html?v=jm-v19-3-provas-minimizacao-definitiva`
4. No motorista, selecionar chamado e clicar em `Ativar GPS para a central`.
5. No gestor, abrir `Central Operacional` ou `Mapa / Tracker`.
6. Conferir se o veículo aparece como `GPS celular motorista` quando não houver tracker.
7. Testar minimização dos painéis no celular e no computador.

## Validação técnica

Executado:

```bash
node --check js/app.js
node --check js/motorista.js
node --check js/utils.js
node --check js/mapa.js
node --check js/google-maps.js
node --check js/firebase.js
node --check js/tracker.js
node --check js/superadmin.js
node --check service-worker.js
```

Sem erros de sintaxe.
