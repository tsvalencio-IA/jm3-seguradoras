# JM Guinchos V19.3 — Correção real de provas e minimização

Correções aplicadas sobre a V19.2.

## Corrigido
- Minimização agora cria um corpo real `.panel-collapse-body` para cada painel e esconde o painel inteiro, não apenas textos.
- CSS global `[hidden]` impede que `.form-grid`, `.grid` ou outras classes sobrescrevam o estado minimizado.
- Ao maximizar painéis com mapa, o sistema dispara resize/invalidate para o Leaflet.
- Upload de provas no motorista recebeu tentativa robusta no Cloudinary:
  - tenta com pasta;
  - se o preset unsigned recusar `folder`/parâmetro, tenta novamente sem pasta;
  - timeout de 45s com erro claro;
  - erro real do Cloudinary aparece na tela.
- Provas podem ser salvas parcialmente sem assinatura, com aviso claro. Para liberar finalização completa, assinatura continua necessária.
- Status de envio permanece visível no formulário.

## Versão de cache
jm-v19-3-provas-minimizacao-definitiva
