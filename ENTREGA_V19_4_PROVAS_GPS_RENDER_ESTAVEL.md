# JM Guinchos V19.4 — Provas, GPS e Render Estável

Correção feita em cima da V19.3.

## Problemas corrigidos

1. Painel motorista piscando/travando ao selecionar chamado
- A tela do motorista reconstruía selects e mapa a cada atualização em tempo real do Firestore.
- Quando o GPS do celular estava ativo, o sistema salvava posição em `calls` e `vehicles`, recebia snapshots de volta e redesenhava a tela repetidamente.
- Agora os selects preservam valor/foco e não são recriados enquanto o usuário está escolhendo um chamado.
- O envio de GPS foi limitado para evitar tempestade de gravações.

2. Provas do atendimento não enviavam em fluxo parcial
- Antes o envio bloqueava se faltasse qualquer foto obrigatória.
- Agora o motorista consegue salvar provas parciais com retorno claro.
- O chamado fica com `proofStatus: parcial` até completar fotos obrigatórias e assinatura.
- O sistema mostra o que falta para ficar completo.

3. Minimização
- A função foi reescrita sem depender de seletor frágil `:scope`.
- O painel agora cria corpo real `.panel-collapse-body` e esconde o conteúdo inteiro.
- O CSS força o painel fechado a ocultar tudo, não apenas texto.

## Arquivos alterados

- `index.html`
- `jm.html`
- `motorista.html`
- `superadmin.html`
- `css/style.css`
- `js/app.js`
- `js/motorista.js`
- `js/utils.js`
- `service-worker.js`

## Versão de cache

`jm-v19-4-provas-gps-render-estavel`

## Como abrir depois de subir

- `jm.html?v=jm-v19-4-provas-gps-render-estavel`
- `motorista.html?v=jm-v19-4-provas-gps-render-estavel`
- `superadmin.html?v=jm-v19-4-provas-gps-render-estavel`
