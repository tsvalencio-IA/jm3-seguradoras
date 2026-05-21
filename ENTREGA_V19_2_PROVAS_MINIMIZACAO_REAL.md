# JM Guinchos V19.2 — Provas com retorno real e minimização confiável

Correção focada nos problemas relatados em campo:

- Envio de provas do motorista agora mostra status persistente dentro do formulário.
- O motorista passa a receber mensagem clara em cada etapa: validação, upload de fotos, upload da assinatura, salvamento no chamado e erro.
- Upload de fotos usa compactação automática antes do envio ao Cloudinary para reduzir falhas em celular.
- A foto de avaria deixou de ser obrigatória quando não existe avaria registrada no checklist.
- Se o registro auxiliar `callProofs` falhar, mas o chamado foi salvo, o sistema informa aviso e não trata como perda total das provas.
- A minimização dos painéis foi refeita de forma controlada: cabeçalho separado, botão estável e sem embrulhar mapas/formulários.
- Ao maximizar painel com mapa, o sistema invalida o tamanho do Leaflet para não quebrar escala.
- Cache/PWA atualizado para `jm-v19-3-provas-minimizacao-definitiva`.

Arquivos alterados:

- motorista.html
- css/style.css
- js/motorista.js
- js/utils.js
- index.html
- jm.html
- superadmin.html
- service-worker.js
- ENTREGA_V19_2_PROVAS_MINIMIZACAO_REAL.md
- LISTA_ARQUIVOS_ALTERADOS_V19_2.txt

Validação executada:

```bash
node --check js/app.js
node --check js/mapa.js
node --check js/motorista.js
node --check js/utils.js
node --check js/google-maps.js
node --check js/firebase.js
node --check js/tracker.js
node --check js/superadmin.js
node --check service-worker.js
```

Observação operacional:

Para enviar fotos e assinatura, Cloudinary precisa estar configurado no superadmin com `cloudName` e `uploadPreset` válido. Se não estiver, o motorista agora verá erro explícito dentro do formulário de provas.
