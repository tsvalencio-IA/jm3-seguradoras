# JM GUINCHOS V18.1 - Correcoes de paineis, GPS e enderecos

## Correcoes aplicadas
- Minimizacao/maximizacao reforcada em `jm.html`, `motorista.html` e `superadmin.html`.
- O botao agora e reaplicado apos carregamento da tela, usa `is-collapsed` e `collapsed`, e respeita `hidden`.
- Motorista ganhou botao direto no card do chamado: `Ativar GPS deste chamado`.
- GPS do celular agora faz uma captura imediata com `getCurrentPosition` e mantem acompanhamento com `watchPosition`.
- Erro de permissao/timeout do GPS nao e mais apagado automaticamente pela mensagem "desligada".
- Se o GPS do celular estiver ativo, o mapa usa a posicao do celular como ponto do motorista, mesmo quando houver rastreador antigo/atrasado.
- Busca de origem/destino nao fica mais bloqueada quando nao existe chave Google.
- Sem chave Google, o sistema tenta busca gratuita via Nominatim/OpenStreetMap com viés para Sao Jose do Rio Preto/SP.
- Com chave Google salva no superadmin, usa Google Places/Geocoding com bias regional.
- Adicionados botoes `Conferir no Google Maps` em origem e destino para abrir a busca verdadeira no Google Maps.
- Cache/PWA atualizado para `jm-guinchos-v18-1-gps-endereco-paineis`.

## Observacao tecnica
Busca 100% precisa digitando endereco diretamente no banco do Google depende de chave Google Maps com Places/Geocoding habilitados. Sem chave, o modo gratuito melhorou, mas ainda pode errar endereco incompleto. Por isso foram mantidos tres caminhos: Google opcional, busca gratuita e abertura direta no Google Maps para conferencia.

## Validacao
Passou em:
- `node --check js/app.js`
- `node --check js/mapa.js`
- `node --check js/motorista.js`
- `node --check js/utils.js`
- `node --check js/google-maps.js`
- `node --check js/firebase.js`
- `node --check js/tracker.js`
- `node --check js/superadmin.js`
- `node --check service-worker.js`

Tambem foi feito teste HTTP local: `jm.html`, `motorista.html`, `superadmin.html` e assets principais responderam `200`.
