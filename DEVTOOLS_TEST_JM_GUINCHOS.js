(function () {
  const ok = (name) => console.log("✅", name);
  const fail = (name, msg) => console.error("❌", name, msg || "falhou");
  const warn = (name, msg) => console.warn("⚠️", name, msg || "atenção");
  const fn = (path) => path.split(".").reduce((acc, key) => acc && acc[key], window);

  console.log("JM Guinchos v12 - teste rápido");

  window.JM && window.JM.utils ? ok("JM.utils carregado") : fail("JM.utils carregado");
  window.JM && window.JM.firebase ? ok("Firebase carregado") : fail("Firebase carregado");
  window.JM && window.JM.tracker ? ok("Tracker carregado") : fail("Tracker carregado");
  fn("JM.freeRouter.rankVehicles") ? ok("Roteirizador gratuito carregado") : fail("Roteirizador gratuito carregado");
  fn("JM.mapa.renderFleetMap") ? ok("Mapa Leaflet/OSM carregado") : fail("Mapa Leaflet/OSM carregado");

  const parsed = window.JM.freeRouter && window.JM.freeRouter.parseLocationInput("-20.851076,-49.398946");
  parsed && parsed.coords ? ok("Parser de coordenadas funcionando") : fail("Parser de coordenadas funcionando");

  const cfg = window.JM_CONFIG || {};
  cfg.tracker && cfg.tracker.endpoint ? ok("Endpoint tracker configurado") : warn("Endpoint tracker", "faltando endpoint");
  cfg.tracker && cfg.tracker.token ? ok("Token tracker presente") : warn("Token tracker", "faltando token");

  console.log("Para testar rota: cole -20.851076,-49.398946 na origem, clique em Ler origem e depois Traçar rota inteligente.");
}());

// TESTES V14 - Rotas OSM/OSRM sem API paga
// Cole no console do navegador depois de abrir jm.html.
(async function testeRotasV14(){
  console.log('JM v14 - testando parser de coordenadas e rota gratuita');
  const router = window.JM && window.JM.freeRouter;
  if (!router) return console.error('JM.freeRouter não carregou');
  const origem = router.parseLocationInput('-20.851076,-49.398946');
  const destino = router.parseLocationInput('-20.811500,-49.376900');
  console.log('Origem lida:', origem);
  console.log('Destino lido:', destino);
  const rota = await router.routeThroughPoints([origem.coords, destino.coords]);
  console.log('Rota OSM/OSRM ou fallback:', rota);
  if (!rota || !rota.geometry) console.error('Falha: rota sem geometria');
  else console.log('OK: geometria com', rota.geometry.coordinates.length, 'pontos');
}());

// JM v15 - testes manuais rápidos da Central Operacional
console.log('[JM V15] Teste esperado: abrir jm.html?v=jm-central-operacional-seguradoras-v15');
console.log('[JM V15] Conferir aba Central Operacional, filtros, seleção de chamado, seleção de veículo, despacho, abrir rota e copiar link.');
console.log('[JM V15] Criar chamado com Origem comercial=Seguradora, protocolo externo, placa do cliente e prioridade urgente.');
