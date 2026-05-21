# JM GUINCHOS V18 - Campo, Seguradoras e Financeiro

## Arquivos principais
- `jm.html`: painel gestor/central, chamados ativos, finalizados, dossie do chamado, clientes, seguradoras, financeiro, frota e integracoes.
- `motorista.html`: painel operacional do motorista com chamados, despesas, localizacao do celular, checklist, fotos e assinatura.
- `superadmin.html`: configuracao de empresa, tracker RAFA, Cloudinary, Google Maps opcional e usuarios.
- `js/app.js`: regras do painel gestor, auditoria, finalizacao, reabertura, dossie, financeiro e integracoes.
- `js/motorista.js`: fluxo de campo, provas operacionais, Cloudinary, assinatura, GPS do celular e bloqueio de finalizacao incompleta.
- `js/google-maps.js`: coordenadas, links de mapa, Google Maps opcional e fallback gratuito com Nominatim/OSRM.
- `js/utils.js`: permissoes, status, dinheiro, validacoes, pontos de rota e paineis minimizaveis.
- `firestore.rules`: regras de usuarios, chamados, financeiro, despesas, auditoria, integracoes e provas.

## O que foi entregue
- Checklist profissional por chamado, com etapas de retirada, carregamento, transporte, entrega e finalizacao.
- Fotos obrigatorias do veiculo guinchado: frente, traseira, laterais, painel/odometro, avarias e comprovante final.
- Assinatura digital em canvas no celular do motorista, com aceite, nome, documento, data/hora, chamado e motorista.
- Upload de fotos e assinatura no Cloudinary; Firestore guarda os metadados e vinculos.
- GPS do celular do motorista quando o veiculo nao tiver rastreador, gravando localizacao no chamado para aparecer como ponto de rota.
- Chamados finalizados saem da fila ativa e entram na aba `Finalizados`.
- Chamado finalizado fica bloqueado; reabertura exige perfil autorizado e gera auditoria.
- Dossie do chamado no painel gestor, com checklist, fotos, assinatura, status e acao de imprimir provas.
- Paineis minimizaveis/maximizaveis para uso melhor no celular.
- Cadastro de clientes/seguradoras fortalecido com regras de cobranca, exigencias de prova e risco de glosa.
- Integracao com seguradoras preserva a fila `integrationInbox` e converte item em chamado sem perder protocolo, sinistro, apolice, cliente, origem, destino e SLA.
- Google Maps passa a ser opcional: se houver chave configurada no superadmin, usa Places/Geocoding; sem chave, continua gratuito com OpenStreetMap/OSRM/Nominatim.
- PWA/cache atualizado para `jm-guinchos-v18-provas-assinatura-seguradoras`.

## O que foi preservado
- HTML, CSS e JavaScript puro.
- Firebase no frontend, Firestore, GitHub Pages e PWA.
- Leaflet/OpenStreetMap, OSRM gratuito e Tracker RAFA.
- Fluxos existentes de gestor, motorista, superadmin, equipe, frota, chamados e financeiro.
- `formulario.html` continua avulso, sem link no `index.html`.

## Limitacoes tecnicas honestas
- GitHub Pages nao recebe webhook de seguradora nem processa e-mail automaticamente. Para integracao 100% automatica, precisa de backend leve: Cloud Function, API, e-mail parser ou robo autorizado.
- Google Maps preciso exige chave Google Maps com Places/Geocoding/Directions habilitados. Sem chave, o sistema usa alternativas gratuitas com menor precisao.
- Exclusao real de usuario no Firebase Authentication nao deve ser feita pelo frontend; isso exige Console Firebase, Admin SDK ou Cloud Function.

## Regras Firestore
Publique o arquivo `firestore.rules` desta entrega no Firebase Console. Sem isso, o motorista pode receber erro de permissao ao salvar provas ou atualizar localizacao.

## Teste rapido real
1. Entre no `superadmin.html` com `tsvalencio@gmail.com`.
2. Configure Tracker RAFA, Cloudinary e, se existir, Google Maps API Key opcional.
3. Crie gestor, gerente, atendente, financeiro e motorista.
4. Entre no `jm.html` como gestor e crie um chamado com seguradora/protocolo/origem/destino/SLA.
5. Despache motorista e veja o chamado no `motorista.html`.
6. No motorista, ative localizacao do celular se o veiculo nao tiver GPS.
7. Preencha checklist, envie fotos obrigatorias e colete assinatura.
8. Finalize o chamado.
9. Volte no gestor: chamado deve sair da fila ativa e aparecer em `Finalizados`.
10. Abra o dossie do chamado e confira fotos, checklist, assinatura e status de faturamento.

## Validacao executada
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
