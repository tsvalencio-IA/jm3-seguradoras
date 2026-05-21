# JM Guinchos — V19 Polimento, Fluxo Financeiro Único e Mobile

Versão de cache: `jm-v19-polimento-fluxo-mobile`

## O que foi corrigido

- Corrigida a acentuação quebrada nos arquivos principais (`operaÃ§Ã£o`, `veÃ­culo`, `manutenÃ§Ã£o`, etc.).
- Padronizada a versão de cache dos HTMLs, scripts e service worker para evitar celular carregando arquivo antigo.
- Melhorado o fluxo financeiro para reduzir lançamentos duplicados:
  - Chamado com valor gera/atualiza uma conta a receber oficial `call_receivable`.
  - Recebimentos vinculados ao chamado agora entram como baixas/histórico de pagamento `payment_receipt`.
  - Pagamentos parciais deixam histórico de parcelas e recalculam saldo do chamado.
  - Excluir lançamento recalcula o chamado e permite voltar para fila de faturamento quando a cobrança oficial foi removida.
- Motorista que finaliza chamado com valor agora envia o chamado para a fila de faturamento da central (`a_faturar`).
- CPF/CNPJ no cadastro de clientes agora possui máscara e validação real antes de salvar.
- Mobile ganhou polimento de usabilidade:
  - inputs com altura mínima melhor;
  - botões maiores;
  - tabelas viram cards no celular;
  - ações críticas ficam em coluna no mobile;
  - assinatura fica com `touch-action: none`.

## Arquivos alterados

- `index.html`
- `jm.html`
- `motorista.html`
- `superadmin.html`
- `css/style.css`
- `js/app.js`
- `js/motorista.js`
- `service-worker.js`
- `ENTREGA_V19_POLIMENTO_FLUXO_MOBILE.md`
- `LISTA_ARQUIVOS_ALTERADOS_V19.txt`

## O que foi preservado

- Login atual.
- Tracker RAFA.
- Leaflet/OpenStreetMap/OSRM.
- Fluxo de chamados, central operacional, motorista, provas, manutenção, frota e financeiro já existentes.
- Arquitetura HTML/CSS/JS puro com Firebase direto no frontend.

## Testes técnicos executados

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

Todos passaram sem erro de sintaxe.

## Teste operacional recomendado

1. Abrir `jm.html?v=jm-v19-polimento-fluxo-mobile`.
2. Criar chamado com valor e veículo/motorista.
3. Finalizar chamado pelo painel do motorista.
4. Conferir no financeiro se entrou como `a_faturar`.
5. Gerar cobrança do chamado.
6. Lançar recebimento parcial vinculado ao chamado.
7. Lançar segundo recebimento parcial.
8. Conferir saldo, pago e histórico em pagamentos/financeiro.
9. Lançar despesa de combustível pelo motorista.
10. Aprovar pelo gestor e conferir saída vinculada ao veículo.
