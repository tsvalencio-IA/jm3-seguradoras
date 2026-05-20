(function () {
  "use strict";

  const {
    $, $all, esc, money, parseMoney, dateTime, todayInput, plateKey, isValidPlate,
    uidSafe, coords, pointFrom, routeKm, mapsRouteUrl, normalizeUrl, toast, statusClass,
    statusKey, statusLabel, isFinalStatus: utilIsFinalStatus, maskPhone, phoneWhatsappUrl
  } = window.JM.utils;
  const { auth, secondaryAuth, db, ts, arrayUnion, emailIsAdmin } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const SYSTEM_SIGNATURE = "Powered by thIAguinho Soluções Digitais";
  const LOGIN_FLOW_VERSION = "jm-v16-refino-saas-guincho-seguradoras";
  let trackerTimer = null;
  let trackerBusy = false;

  const state = {
    user: null,
    profile: null,
    vehicles: {},
    calls: {},
    users: {},
    expenses: {},
    transactions: {},
    maintenance: {},
    settings: {},
    addresses: { origin: null, destination: null, waypoints: [] },
    smartRoute: null,
    selectedCallId: null,
    selectedVehicleId: null,
    operationFilter: "ativos",
    operationPriorityFilter: "",
    operationInsuranceFilter: "",
    operationDriverFilter: "",
    operationVehicleFilter: "",
    editingCallId: null,
    editingUserId: null,
    editingTransactionId: null,
    editingMaintenanceId: null
  };

  const unsubscribers = [];
  const OFFICE_ROLES = ["admin", "finance", "gestor", "owner", "manager", "gerente", "auxiliar", "atendente"];
  const OWNER_ROLES = ["admin", "superadmin", "gestor", "owner", "manager"];
  const FINANCE_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "finance"];
  const FLEET_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "gerente"];
  const OPERATIONS_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "gerente", "auxiliar", "atendente"];
  const DRIVER_ROLES = ["driver", "motorista"];

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isOffice() {
    return state.profile && OFFICE_ROLES.includes(normalizedRole(state.profile.role));
  }

  function hasRole(list) {
    return state.profile && list.includes(normalizedRole(state.profile.role));
  }

  function canOwnCompany() {
    return hasRole(OWNER_ROLES);
  }

  function isAdmin() {
    return canOwnCompany();
  }

  function canOperateCalls() {
    return hasRole(OPERATIONS_ROLES) || hasRole(FINANCE_ROLES);
  }

  function canManageFinance() {
    return hasRole(FINANCE_ROLES);
  }

  function canManageFleet() {
    return hasRole(FLEET_ROLES);
  }

  function canManageTeam() {
    return canOwnCompany();
  }

  function canSeeSensitiveFinance() {
    return canManageFinance();
  }

  function isFinalStatus(status) {
    return utilIsFinalStatus(status);
  }

  function operationalStatus(status) {
    return statusLabel(status);
  }

  function operationalKey(status) {
    return statusKey(status);
  }

  function priorityWeight(call) {
    const p = String(call && call.priority || "normal").toLowerCase();
    if (p === "urgente") return 0;
    if (p === "alta") return 1;
    return 2;
  }

  function minutesSince(value) {
    if (!value) return null;
    const d = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    const ms = Date.now() - d.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.round(ms / 60000));
  }

  function routeForCall(call, preferredVehicleId) {
    const vehicle = state.vehicles[preferredVehicleId || call && call.vehicleId] || null;
    return call && (call.routeExternalUrl || call.routeUrl) || mapsRouteUrl(call, vehicle);
  }

  function canManageTracker() {
    return canOwnCompany() || normalizedRole(state.profile && state.profile.role) === "gerente";
  }

  function activeCloudinaryConfig() {
    return Object.assign({}, cfg.cloudinary || {}, state.settings.cloudinary || {});
  }

  function mergeNonEmpty(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        out[key] = Object.assign({}, out[key] || {}, value);
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  function activeMapSettings() {
    return mergeNonEmpty(cfg.map || {}, state.settings.map || state.settings.googleMaps || {});
  }

  function activeTrackerSettings() {
    return mergeNonEmpty(cfg.tracker || {}, state.settings.tracker || {});
  }

  function visibleRows(rows) {
    return Object.values(rows || {}).filter((row) => row && !row.deletedAt);
  }

  function personName() {
    return state.profile && (state.profile.nome || state.profile.email) || state.user && state.user.email || "sistema";
  }

  async function writeAudit(action, collectionName, docId, oldData, reason) {
    try {
      await db.collection("auditLogs").add({
        action,
        collection: collectionName,
        docId,
        reason: reason || "",
        oldData: oldData || null,
        profileRole: state.profile && state.profile.role || "",
        byUid: state.user && state.user.uid || "",
        byEmail: state.user && state.user.email || "",
        byName: personName(),
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      console.warn("Falha ao gravar auditoria", err);
      toast("A ação foi preparada, mas a auditoria foi bloqueada. Publique as firestore.rules da V16 antes de operar exclusões.", "danger");
      throw err;
    }
  }

  async function softDeleteDoc(collectionName, id, oldData, reason) {
    await writeAudit("delete", collectionName, id, oldData, reason);
    await db.collection(collectionName).doc(id).set({
      deletedAt: new Date().toISOString(),
      deletedBy: state.user.uid,
      deletedByEmail: state.user.email,
      auditReason: reason || ""
    }, { merge: true });
  }

  function currentStatusKey(call) {
    return operationalKey(call && (call.statusKey || call.status));
  }

  function slaInfo(call) {
    if (!call || !call.slaLimitAt) return { label: "Sem SLA", className: "muted", overdue: false };
    const limit = new Date(call.slaLimitAt);
    if (Number.isNaN(limit.getTime())) return { label: "SLA inválido", className: "warn", overdue: false };
    const diff = limit.getTime() - Date.now();
    if (isFinalStatus(call)) return { label: "SLA encerrado", className: "ok", overdue: false };
    if (diff < 0) return { label: "SLA vencido", className: "danger", overdue: true };
    const minutes = Math.ceil(diff / 60000);
    if (minutes <= 30) return { label: "SLA em " + minutes + " min", className: "warn", overdue: false };
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return { label: "SLA em " + (hours ? hours + "h " : "") + rest + "min", className: "ok", overdue: false };
  }

  function setButtonBusy(button, busy, text) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = text || "Aguarde...";
    } else {
      button.disabled = false;
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    }
  }

  function addressStatus(id, message, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = "small geo-status " + (type || "muted");
  }

  function setAddress(kind, address) {
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const latId = isOrigin ? "callOriginLat" : "callDestLat";
    const lngId = isOrigin ? "callOriginLng" : "callDestLng";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    const point = pointFrom(address && (address.coords || address));
    const normalized = {
      label: address && address.label || $(labelId).value.trim(),
      coords: point,
      placeId: address && address.placeId || "",
      source: address && address.source || "manual",
      resolvedAt: address && address.resolvedAt || new Date().toISOString()
    };
    state.addresses[kind] = normalized;
    if (normalized.label) $(labelId).value = normalized.label;
    if (point) {
      $(latId).value = String(point.lat);
      $(lngId).value = String(point.lng);
      addressStatus(statusId, "Endereço validado: " + normalized.label + " (" + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + ")", "ok");
    } else {
      addressStatus(statusId, "Endereço ainda sem coordenadas. Cole link do mapa com coordenadas ou informe latitude/longitude.", "danger");
    }
    state.smartRoute = null;
    renderSmartRouteBox();
    return normalized;
  }

  function routeLinkStatus(message, type) {
    const el = $("routeLinkStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "small route-link-status " + (type || "muted");
  }

  function currentExternalRouteUrl() {
    const input = $("callRouteExternalUrl");
    return normalizeUrl(input && input.value || "");
  }

  function routePointsFromForm(includeVehicle) {
    const points = [];
    const selectedVehicle = includeVehicle ? state.vehicles[$("callVehicle") && $("callVehicle").value] || null : null;
    const origin = addressFromInputs("origin");
    const destination = addressFromInputs("destination");
    if (selectedVehicle && selectedVehicle.location) points.push(selectedVehicle.location);
    if (origin && origin.coords) points.push(origin.coords);
    (state.addresses.waypoints || []).forEach((wp) => { if (wp && wp.coords) points.push(wp.coords); });
    if (destination && destination.coords) points.push(destination.coords);
    return points;
  }

  function addressFromInputs(kind) {
    const isOrigin = kind === "origin";
    const label = $(isOrigin ? "callOriginLabel" : "callDestLabel").value.trim();
    const point = coords($(isOrigin ? "callOriginLat" : "callDestLat").value, $(isOrigin ? "callOriginLng" : "callDestLng").value);
    const existing = state.addresses[kind] || {};
    if (!label && !point) return null;
    return {
      label: label || existing.label || "",
      coords: point || existing.coords || null,
      placeId: existing.placeId || "",
      source: existing.source || (point ? "manual_coords" : "manual_text"),
      resolvedAt: existing.resolvedAt || new Date().toISOString()
    };
  }

  function initializeAddressTools() {
    const gm = window.JM.googleMaps;
    if (!gm) return;
    if (!gm.isConfigured(activeMapSettings())) {
      addressStatus("originGeoStatus", "Modo gratuito ativo: cole link compartilhado do mapa ou coordenadas. Não usa API paga.", "warn");
      return;
    }
    gm.initAutocomplete("callOriginLabel", (addr) => setAddress("origin", addr), activeMapSettings()).catch((err) => addressStatus("originGeoStatus", err.message, "danger"));
    gm.initAutocomplete("callDestLabel", (addr) => setAddress("destination", addr), activeMapSettings()).catch((err) => addressStatus("destGeoStatus", err.message, "danger"));
    addressStatus("originGeoStatus", "Modo gratuito ativo: cole link do Google Maps/Waze ou coordenadas.", "ok");
    addressStatus("destGeoStatus", "Destino pode ser link compartilhado ou coordenadas.", "ok");
  }

  async function geocodeAddress(kind) {
    const gm = window.JM.googleMaps;
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    try {
      if (!gm || !gm.isConfigured(activeMapSettings())) throw new Error("Cole um link de mapa com coordenadas visíveis ou informe latitude/longitude.");
      addressStatus(statusId, "Lendo link/coordenadas...", "muted");
      const addr = await gm.geocode($(labelId).value.trim(), activeMapSettings());
      setAddress(kind, addr);
      toast((isOrigin ? "Origem" : "Destino") + " lido com coordenadas.", "ok");
    } catch (err) {
      addressStatus(statusId, err.message, "danger");
      toast(err.message, "danger");
    }
  }

  function useCurrentLocationAsOrigin() {
    if (!navigator.geolocation) return toast("Este navegador não liberou geolocalização.", "danger");
    addressStatus("originGeoStatus", "Capturando localização do aparelho...", "muted");
    navigator.geolocation.getCurrentPosition((pos) => {
      setAddress("origin", {
        label: "Localização atual do aparelho",
        coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        source: "browser_geolocation",
        resolvedAt: new Date().toISOString()
      });
      toast("Localização atual aplicada como origem.", "ok");
    }, (err) => {
      addressStatus("originGeoStatus", "Não foi possível obter localização: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 12000 });
  }

  function bestSmartRoute() {
    return state.smartRoute && state.smartRoute.rankings && state.smartRoute.rankings[0] || null;
  }

  function renderSmartRouteBox() {
    const box = $("smartRouteBox");
    if (!box) return;
    const route = state.smartRoute;
    if (!route || !route.rankings || !route.rankings.length) {
      box.innerHTML = "Informe a origem e clique em <b>Traçar rota inteligente</b>. O algoritmo usa posição do tracker, status do veículo, distância e tempo estimado.";
      return;
    }
    box.innerHTML = route.rankings.slice(0, 5).map((r, i) => {
      const v = r.vehicle || {};
      const badge = i === 0 ? '<span class="badge ok">RECOMENDADO</span>' : '<span class="badge info">Opção ' + (i + 1) + '</span>';
      const src = r.toOrigin && r.toOrigin.source === "osrm_openstreetmap" ? "OSM/OSRM por ruas" : "fallback estimado";
      return `<div class="smart-route-card">
        <div>${badge} <b>${esc(v.placa || v.id || "Veículo")}</b> <span class="muted">${esc(v.apelido || v.tipo || "")}</span></div>
        <div>Até a origem: <b>${esc(r.toOrigin.distanceText || r.kmToOrigin.toFixed(1) + " km")}</b> · <b>${esc(r.toOrigin.durationTrafficText || r.toOrigin.durationText || r.minutesToOrigin + " min")}</b> · fonte: ${esc(src)}</div>
        ${r.serviceRoute ? `<div>Origem → destino: <b>${esc(r.serviceRoute.distanceText || "")}</b> · <b>${esc(r.serviceRoute.durationTrafficText || r.serviceRoute.durationText || "")}</b></div>` : ""}
        <div class="actions"><button class="btn primary" type="button" onclick="JM.app.applySmartVehicle('${esc(v.id)}')">Usar este veículo</button>${r.routeUrl ? `<a class="btn" target="_blank" href="${esc(r.routeUrl)}">Abrir rota</a>` : ""}</div>
      </div>`;
    }).join("");
  }

  async function calculateSmartRoute() {
    const gm = window.JM.googleMaps;
    const origin = addressFromInputs("origin");
    let destination = addressFromInputs("destination");
    if (!origin || !origin.coords) {
      if (origin && origin.label && gm && gm.isConfigured(activeMapSettings())) {
        await geocodeAddress("origin");
      }
    }
    const finalOrigin = addressFromInputs("origin");
    if (!finalOrigin || !finalOrigin.coords) return toast("Informe a origem por link do mapa ou latitude/longitude antes da rota inteligente.", "danger");
    if (destination && destination.label && !destination.coords && gm && gm.isConfigured(activeMapSettings())) {
      await geocodeAddress("destination");
      destination = addressFromInputs("destination");
    }
    const located = Object.values(state.vehicles || {}).filter((v) => pointFrom(v.location));
    if (!located.length) return toast("Nenhum veículo tem posição de tracker. Sincronize o tracker no superadmin primeiro.", "danger");
    $("smartRouteBox").innerHTML = "Calculando melhor veículo e tempo de rota...";
    try {
      const rankings = await gm.rankVehicles(state.vehicles, finalOrigin.coords, destination && destination.coords, activeMapSettings());
      state.smartRoute = { origin: finalOrigin, destination, rankings, calculatedAt: new Date().toISOString() };
      const best = bestSmartRoute();
      if (best && !$("callVehicle").value) $("callVehicle").value = best.vehicle.id;
      renderSmartRouteBox();
      toast("Rota inteligente calculada por ruas/rodovias quando o OSRM estiver disponível.", "ok");
    } catch (err) {
      $("smartRouteBox").innerHTML = `<span class="danger">${esc(err.message)}</span>`;
      toast(err.message, "danger");
    }
  }

  function applySmartVehicle(vehicleId) {
    if ($("callVehicle")) $("callVehicle").value = vehicleId || "";
    toast("Veículo aplicado ao chamado.", "ok");
  }

  async function readSharedRouteLink() {
    const gm = window.JM.googleMaps;
    const input = $("callRouteExternalUrl");
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return routeLinkStatus("Cole um link de rota do Maps/Waze ou uma URL com coordenadas.", "danger");
    const parsed = gm && gm.parseRouteInput ? gm.parseRouteInput(raw) : { externalUrl: normalizeUrl(raw), points: [] };
    if (parsed.externalUrl) input.value = parsed.externalUrl;
    if (!parsed.points || !parsed.points.length) {
      routeLinkStatus("Link salvo para abrir fora do sistema. Ele não trouxe coordenadas visíveis; mantenha origem/destino preenchidos para desenhar a rota no mapa interno.", "warn");
      return;
    }
    if (parsed.points.length === 1) {
      setAddress("destination", {
        label: "Ponto do link compartilhado",
        coords: parsed.points[0],
        source: parsed.source,
        provider: parsed.provider,
        externalUrl: parsed.externalUrl,
        resolvedAt: parsed.resolvedAt
      });
      routeLinkStatus("Link lido com 1 coordenada. Usei como destino. Se for origem, ajuste no campo correto.", "ok");
      return;
    }
    setAddress("origin", {
      label: "Origem do link compartilhado",
      coords: parsed.points[0],
      source: parsed.source,
      provider: parsed.provider,
      externalUrl: parsed.externalUrl,
      resolvedAt: parsed.resolvedAt
    });
    const last = parsed.points[parsed.points.length - 1];
    setAddress("destination", {
      label: "Destino do link compartilhado",
      coords: last,
      source: parsed.source,
      provider: parsed.provider,
      externalUrl: parsed.externalUrl,
      resolvedAt: parsed.resolvedAt
    });
    state.addresses.waypoints = parsed.points.slice(1, -1).map((point, index) => ({
      label: "Parada " + (index + 1) + " do link compartilhado",
      coords: point,
      source: parsed.source,
      provider: parsed.provider,
      resolvedAt: parsed.resolvedAt
    }));
    routeLinkStatus("Link de rota lido com " + parsed.points.length + " ponto(s). O mapa interno vai desenhar por ruas usando OSM/OSRM.", "ok");
    await calculateSmartRoute();
  }

  function openGoogleRouteFromForm() {
    const external = currentExternalRouteUrl();
    const points = routePointsFromForm(true);
    const url = external || (window.JM.googleMaps && window.JM.googleMaps.routeUrl(points) || mapsRouteUrl(points));
    if (!url) return toast("Informe origem/destino e selecione veículo com posição para abrir a rota.", "danger");
    window.open(url, "_blank");
  }

  function showView(name) {
    $all(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $all("#navButtons button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    const titles = {
      dashboard: "Dashboard",
      operacao: "Central Operacional",
      chamados: "Chamados",
      mapa: "Mapa / Tracker",
      motorista: "Painel motorista",
      financeiro: "Financeiro",
      frota: "Frota",
      equipe: "Equipe"
    };
    $("pageTitle").textContent = titles[name] || name;
    document.body.classList.remove("menu-open");
    refreshMaps();
  }

  function bindNavigation() {
    $all("#navButtons button").forEach((btn) => {
      btn.onclick = () => showView(btn.dataset.view);
    });
    $("menuBtn").onclick = () => document.body.classList.toggle("menu-open");
    if ($("opsStatusFilter")) $("opsStatusFilter").onchange = (e) => { state.operationFilter = e.target.value || "ativos"; renderOperations(); refreshMaps(); };
    ["Priority", "Insurance", "Driver", "Vehicle"].forEach((name) => {
      const id = "ops" + name + "Filter";
      const key = "operation" + name + "Filter";
      if ($(id)) $(id).onchange = (e) => { state[key] = e.target.value || ""; renderOperations(); refreshMaps(); };
    });
    if ($("btnOpsRefreshTracker")) $("btnOpsRefreshTracker").onclick = () => syncTrackerNow(true);
    if ($("btnOpsNewCall")) $("btnOpsNewCall").onclick = () => showView("chamados");
    if ($("btnOpsAssignVehicle")) $("btnOpsAssignVehicle").onclick = assignSelectedVehicleToSelectedCall;
    if ($("btnOpsOpenRoute")) $("btnOpsOpenRoute").onclick = openSelectedCallRoute;
    if ($("btnOpsCopyRoute")) $("btnOpsCopyRoute").onclick = copySelectedCallRoute;
    $("logoutBtn").onclick = () => auth.signOut();
  }

  function setSubmitText(formId, text) {
    const button = document.querySelector(`#${formId} button[type="submit"]`);
    if (button) button.textContent = text;
  }

  function setValue(id, value) {
    const el = $(id);
    if (el) el.value = value == null ? "" : String(value);
  }

  function resetCallForm() {
    if ($("callForm")) $("callForm").reset();
    state.editingCallId = null;
    state.addresses = { origin: null, destination: null, waypoints: [] };
    state.smartRoute = null;
    setSubmitText("callForm", "Registrar chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.add("hidden");
    renderSmartRouteBox();
    addressStatus("originGeoStatus", "Aguardando link do mapa ou coordenadas.", "muted");
    addressStatus("destGeoStatus", "Destino opcional; pode ser link compartilhado ou coordenadas.", "muted");
    routeLinkStatus("Opcional: cole o link compartilhado da rota para abrir no Maps/Waze e, se ele trouxer coordenadas visíveis, preencher origem/destino.", "muted");
    if ($("callRouteExternalUrl")) $("callRouteExternalUrl").value = "";
  }

  function resetTeamForm() {
    if ($("teamForm")) $("teamForm").reset();
    state.editingUserId = null;
    if ($("teamEmail")) $("teamEmail").readOnly = false;
    if ($("teamPass")) $("teamPass").placeholder = "mínimo 6 caracteres";
    setSubmitText("teamForm", "Criar/atualizar equipe");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.add("hidden");
  }

  function resetFinanceForm() {
    if ($("financeForm")) $("financeForm").reset();
    state.editingTransactionId = null;
    setSubmitText("financeForm", "Salvar financeiro");
    if ($("financeCancelEdit")) $("financeCancelEdit").classList.add("hidden");
    if ($("finDate")) $("finDate").value = todayInput();
  }

  function resetMaintenanceForm() {
    if ($("maintenanceForm")) $("maintenanceForm").reset();
    state.editingMaintenanceId = null;
    setSubmitText("maintenanceForm", "Salvar manutenção");
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").classList.add("hidden");
    if ($("maintenanceDate")) $("maintenanceDate").value = todayInput();
  }

  function bindInputMasks() {
    const phone = $("callPhone");
    if (phone) phone.oninput = () => { phone.value = maskPhone(phone.value); };
    ["callCustomerPlate", "vehiclePlate"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = () => { el.value = plateKey(el.value); };
    });
    ["callPrice", "callExtraKm", "finAmount", "maintenanceCost"].forEach((id) => {
      const el = $(id);
      if (el) el.onblur = () => { if (el.value) el.value = String(parseMoney(el.value)).replace(".", ","); };
    });
  }

  function reportSignature() {
    return `<div class="report-signature">${SYSTEM_SIGNATURE}</div>`;
  }

  function gestorAccessAllowedByConfig(user) {
    const authCfg = cfg.auth || {};
    // Mantém a trava por lista de e-mails quando ela existir.
    // Se a lista estiver vazia/removida, o sistema permite o primeiro gestor criar o perfil.
    const list = (authCfg.adminEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean);
    if (!list.length) return { allowed: true, role: "admin", source: "config-empty" };
    return emailIsAdmin(user.email) ? { allowed: true, role: "admin", source: "config" } : { allowed: false };
  }

  async function gestorAccessAllowedByRegistry(user) {
    const email = String(user && user.email || "").toLowerCase().trim();
    if (!email) return { allowed: false };
    try {
      const snap = await db.collection("managerAccess").doc(email).get();
      if (!snap.exists) return { allowed: false };
      const data = snap.data() || {};
      const role = normalizedRole(data.role || "admin");
      if (data.active === false) return { allowed: false, reason: "inactive" };
      if (!OFFICE_ROLES.includes(role)) return { allowed: false, reason: "not-manager-role" };
      return { allowed: true, role, source: "managerAccess" };
    } catch (err) {
      console.warn("Falha ao verificar managerAccess", err);
      return { allowed: false, error: err };
    }
  }

  async function emailReservedForManager(email) {
    const normalized = String(email || "").toLowerCase().trim();
    if (!normalized) return false;
    if (emailIsAdmin(normalized)) return true;
    try {
      const snap = await db.collection("managerAccess").doc(normalized).get();
      return snap.exists && (snap.data() || {}).active !== false;
    } catch (err) {
      console.warn("Falha ao verificar gestor reservado", err);
      return false;
    }
  }

  async function saveGestorProfile(ref, profile, existingData) {
    const payload = existingData ? profile : Object.assign({ createdAt: ts() }, profile);
    await ref.set(payload, { merge: true });
    return { id: profile.uid, ...(existingData || {}), ...profile };
  }

  async function ensureGestorProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    const current = snap.exists ? { id: user.uid, ...snap.data() } : null;

    if (current && current.active === false) {
      throw new Error("Este usuário está inativo no cadastro da JM Guinchos.");
    }

    const baseProfile = {
      uid: user.uid,
      email: user.email,
      nome: (current && current.nome) || user.displayName || user.email.split("@")[0],
      active: true,
      updatedAt: ts()
    };

    if (current && OFFICE_ROLES.includes(normalizedRole(current.role))) {
      return { ...current, role: normalizedRole(current.role) };
    }

    const configAccess = gestorAccessAllowedByConfig(user);
    const registryAccess = configAccess.allowed ? configAccess : await gestorAccessAllowedByRegistry(user);
    if (!registryAccess.allowed) {
      throw new Error("Este e-mail não está liberado como gestor. Crie/libere o gestor no superadmin antes de acessar o jm.html.");
    }

    // Correção definitiva do bug: jm.html é painel gestor.
    // Se o usuário foi criado como driver/motorista por fluxo antigo, repara para admin/financeiro
    // usando a autorização por e-mail gravada pelo superadmin em managerAccess/{email}.
    const repairedProfile = {
      ...baseProfile,
      role: registryAccess.role || "admin",
      loginFixedAt: new Date().toISOString(),
      loginFlowVersion: LOGIN_FLOW_VERSION,
      managerAccessSource: registryAccess.source || "unknown"
    };

    try {
      return await saveGestorProfile(ref, repairedProfile, current || null);
    } catch (err) {
      if (err && err.code === "permission-denied") {
        throw new Error("O login foi aceito, mas o Firestore bloqueou a correção do perfil. Publique as novas firestore.rules deste ZIP ou altere o documento users/" + user.uid + " para role: admin.");
      }
      throw err;
    }
  }



  function setTrackerStatus(message, type) {
    const el = $("trackerStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "muted small " + (type || "");
  }

  async function syncTrackerNow(manual) {
    const tracker = activeTrackerSettings();
    if (!tracker.endpoint || !tracker.token) {
      setTrackerStatus("Tracker sem endpoint/token. Configure no superadmin.", "warn");
      if (manual) toast("Configure endpoint e token do Tracker no superadmin.", "danger");
      return [];
    }
    if (!canManageTracker()) {
      setTrackerStatus("Tracker ativo somente para gestor/gerente sincronizar.", "warn");
      return [];
    }
    if (trackerBusy) return [];
    trackerBusy = true;
    try {
      setTrackerStatus("Sincronizando Tracker RAFA...", "info");
      const positions = await window.JM.tracker.syncTrackerToFirestore(tracker, db, state.vehicles);
      const matched = positions.filter((p) => p.trackerMatched).length;
      const unmapped = positions.length - matched;
      const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const detail = unmapped > 0 ? ` (${unmapped} sem vinculo com placa; ajuste o deviceId no superadmin)` : "";
      setTrackerStatus(`Tracker RAFA sincronizado: ${positions.length} posição(ões), ${matched} vinculada(s) às ${now}${detail}.`, unmapped > 0 ? "warn" : "ok");
      if (manual) toast(`${positions.length} posição(ões) sincronizada(s), ${matched} vinculada(s).${detail}`, unmapped > 0 ? "warn" : "ok");
      return positions;
    } catch (err) {
      console.error(err);
      setTrackerStatus("Falha no Tracker: " + (err && err.message || err), "danger");
      if (manual) toast("Falha no Tracker: " + (err && err.message || err), "danger");
      return [];
    } finally {
      trackerBusy = false;
    }
  }

  function restartTrackerAutoSync() {
    if (trackerTimer) {
      clearInterval(trackerTimer);
      trackerTimer = null;
    }
    const tracker = activeTrackerSettings();
    if (!tracker.endpoint || !tracker.token) {
      setTrackerStatus("Tracker aguardando endpoint/token no superadmin.", "warn");
      return;
    }
    const polling = Math.max(15000, Number(tracker.pollingMs || 30000));
    setTrackerStatus("Tracker configurado. Atualização automática a cada " + Math.round(polling / 1000) + "s.", "ok");
    syncTrackerNow(false);
    trackerTimer = setInterval(() => syncTrackerNow(false), polling);
  }


  function listenCollection(name, target) {
    const unsub = db.collection(name).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state[target] = rows;
      renderAll();
    }, (err) => {
      console.error(err);
      toast("Falha ao ouvir " + name + ": " + err.message, "danger");
    });
    unsubscribers.push(unsub);
  }

  function startListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    const baseCollections = ["vehicles", "calls", "users"];
    if (canManageFinance()) baseCollections.push("expenses", "transactions");
    if (canManageFleet() || canManageFinance()) baseCollections.push("maintenance");
    baseCollections.forEach((name) => listenCollection(name, name));
    const settingsUnsub = db.collection("settings").doc("integrations").onSnapshot((snap) => {
      state.settings = snap.exists ? snap.data() : {};
      initializeAddressTools();
      restartTrackerAutoSync();
      renderAll();
    });
    unsubscribers.push(settingsUnsub);
  }

  function stopListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    if (trackerTimer) { clearInterval(trackerTimer); trackerTimer = null; }
  }

  function applyRoleVisibility() {
    const visibility = {
      financeiro: canManageFinance(),
      frota: canManageFleet(),
      equipe: canManageTeam()
    };
    Object.entries(visibility).forEach(([view, allowed]) => {
      const btn = document.querySelector(`#navButtons button[data-view="${view}"]`);
      if (btn) btn.classList.toggle("hidden", !allowed);
    });
    // Importante: nunca redirecionar o jm.html para motorista.html.
    const active = document.querySelector(".view.active");
    if (active) {
      const current = active.id.replace("view-", "");
      if (visibility[current] === false) showView("dashboard");
    }
  }

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    state.user = user || null;
    state.profile = null;
    if (!user) {
      $("loginView").classList.remove("hidden");
      $("appView").classList.add("hidden");
      return;
    }

    try {
      state.profile = await ensureGestorProfile(user);
      $("loginView").classList.add("hidden");
      $("appView").classList.remove("hidden");
      $("userBox").innerHTML = `<b>${esc(state.profile.nome || user.email)}</b><br>${esc(user.email)}<br><span class="badge info">${esc(state.profile.role)}</span>`;
      applyRoleVisibility();
      startListeners();
    } catch (err) {
      $("appView").classList.add("hidden");
      $("loginView").classList.remove("hidden");
      $("loginError").textContent = err && err.message ? err.message : "Acesso de gestor não autorizado.";
      await auth.signOut().catch(() => {});
    }
  });

  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPass").value);
    } catch (err) {
      $("loginError").textContent = friendlyAuthError(err);
    }
  };

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      return "Usuário ou senha inválidos. O acesso de gestor deve existir no Firebase Authentication.";
    }
    if (code === "auth/operation-not-allowed") {
      return "Ative o provedor E-mail/Senha no Firebase Authentication.";
    }
    if (code === "auth/too-many-requests") {
      return "Muitas tentativas. Aguarde alguns minutos ou redefina a senha no Firebase.";
    }
    return "Acesso negado: " + (err && err.message || "falha de autenticação");
  }

  function renderAll() {
    renderSelects();
    renderDashboard();
    renderOperations();
    renderCalls();
    renderVehicles();
    renderMaintenance();
    renderTeam();
    if ($("driverCalls")) renderDriverPanel();
    renderFinance();
    refreshMaps();
  }

  function setOptionsPreservingValue(id, html) {
    const el = $(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = html;
    if (current && Array.from(el.options).some((opt) => opt.value === current)) el.value = current;
  }

  function renderSelects() {
    const vehicles = visibleRows(state.vehicles);
    const calls = visibleRows(state.calls);
    const vehicleOptions = vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)} - ${esc(v.apelido || v.tipo || "")}</option>`).join("");
    setOptionsPreservingValue("callVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("expenseVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("finVehicle", `<option value="">Sem veículo</option>${vehicleOptions}`);
    setOptionsPreservingValue("maintenanceVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    const drivers = visibleRows(state.users).filter((u) => u.active !== false && DRIVER_ROLES.includes(normalizedRole(u.role)));
    const driverOptions = drivers.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join("");
    setOptionsPreservingValue("callDriver", `<option value="">Selecione</option>` + drivers.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join(""));
    setOptionsPreservingValue("finDriver", `<option value="">Sem motorista</option>${driverOptions}`);
    const callOptions = calls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente || c.id)}</option>`).join("");
    setOptionsPreservingValue("finCall", `<option value="">Sem chamado</option>${callOptions}`);
    const myCalls = calls.filter((c) => c.driverId === state.user?.uid && !isFinalStatus(c));
    setOptionsPreservingValue("expenseCall", `<option value="">Sem chamado</option>` + myCalls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join(""));
  }

  function renderDashboard() {
    const calls = visibleRows(state.calls);
    const active = calls.filter((c) => !isFinalStatus(c.status));
    const now = new Date();
    const transactions = visibleRows(state.transactions);
    const expenses = visibleRows(state.expenses);
    const revenue = transactions.filter((t) => t.type === "entrada").filter((t) => {
      const d = new Date(t.date || t.createdAt || 0);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const pendingExpenses = expenses.filter((e) => e.status === "pendente").reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const online = visibleRows(state.vehicles).filter((v) => v.location && v.lastTrackerAt).length;
    $("kpiActiveCalls").textContent = active.length;
    $("kpiRevenue").textContent = canSeeSensitiveFinance() ? money(revenue) : "Restrito";
    $("kpiExpenses").textContent = canSeeSensitiveFinance() ? money(pendingExpenses) : "Restrito";
    $("kpiOnline").textContent = online;
    const events = calls.flatMap((c) => (c.timeline || []).map((t) => ({ ...t, call: c }))).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 10);
    $("timelineBox").innerHTML = events.length ? events.map((e) => `<div class="timeline-item"><b>${esc(e.call.protocolo || e.call.cliente || "Chamado")}</b><br><span>${esc(e.text || "")}</span><br><small>${dateTime(e.at)}</small></div>`).join("") : `<p class="muted">Sem eventos ainda.</p>`;
  }

  function filteredOperationCalls() {
    const filter = state.operationFilter || "ativos";
    return visibleRows(state.calls).filter((c) => {
      if (filter === "todos") return true;
      if (filter === "ativos") return !isFinalStatus(c.status);
      return currentStatusKey(c) === filter || operationalStatus(c) === filter;
    }).filter((c) => {
      if (state.operationPriorityFilter && String(c.priority || "") !== state.operationPriorityFilter) return false;
      if (state.operationInsuranceFilter && String(c.insurance || c.source || "") !== state.operationInsuranceFilter) return false;
      if (state.operationDriverFilter && String(c.driverId || "") !== state.operationDriverFilter) return false;
      if (state.operationVehicleFilter && String(c.vehicleId || "") !== state.operationVehicleFilter) return false;
      return true;
    }).sort((a, b) => {
      const pa = priorityWeight(a) - priorityWeight(b);
      if (pa) return pa;
      const sa = slaInfo(a).overdue ? -1 : 0;
      const sb = slaInfo(b).overdue ? -1 : 0;
      if (sa !== sb) return sa - sb;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
  }

  function renderOperations() {
    if (!$("opsKpis")) return;
    const calls = visibleRows(state.calls);
    const active = calls.filter((c) => !isFinalStatus(c.status));
    const waiting = active.filter((c) => currentStatusKey(c) === "aguardando_despacho");
    const inRoute = active.filter((c) => ["despachado", "motorista_a_caminho", "motorista_no_local", "veiculo_carregado", "em_transporte"].includes(currentStatusKey(c)));
    const insurance = active.filter((c) => String(c.source || c.origemComercial || "").toLowerCase().includes("segur") || String(c.insurance || "").trim());
    const onlineVehicles = visibleRows(state.vehicles).filter((v) => v.location && v.lastTrackerAt);
    const overdue = active.filter((c) => slaInfo(c).overdue);
    const visibleValue = canSeeSensitiveFinance() ? money(active.reduce((s, c) => s + Number(c.valor || 0), 0)) : "Restrito";
    const insuranceOptions = Array.from(new Set(active.map((c) => c.insurance || c.source || "").filter(Boolean))).sort();
    const driverOptions = visibleRows(state.users).filter((u) => u.active !== false && DRIVER_ROLES.includes(normalizedRole(u.role)));
    const vehicleOptions = visibleRows(state.vehicles).sort((a, b) => String(a.placa || a.id || "").localeCompare(String(b.placa || b.id || "")));
    setOptionsPreservingValue("opsInsuranceFilter", `<option value="">Todas seguradoras</option>` + insuranceOptions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join(""));
    setOptionsPreservingValue("opsDriverFilter", `<option value="">Todos motoristas</option>` + driverOptions.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join(""));
    setOptionsPreservingValue("opsVehicleFilter", `<option value="">Todos veículos</option>` + vehicleOptions.map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)}</option>`).join(""));
    $("opsKpis").innerHTML = `
      <div class="card kpi col-3"><span>Fila ativa</span><strong>${active.length}</strong></div>
      <div class="card kpi col-3"><span>Aguardando despacho</span><strong>${waiting.length}</strong></div>
      <div class="card kpi col-3"><span>Em atendimento</span><strong>${inRoute.length}</strong></div>
      <div class="card kpi col-3"><span>Seguradoras/assistências</span><strong>${insurance.length}</strong></div>
      <div class="card kpi col-3"><span>Frota online</span><strong>${onlineVehicles.length}</strong></div>
      <div class="card kpi col-3"><span>Sem rota precisa</span><strong>${active.filter((c) => !(c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise)).length}</strong></div>
      <div class="card kpi col-3"><span>Urgentes</span><strong>${active.filter((c) => String(c.priority).toLowerCase() === "urgente").length}</strong></div>
      <div class="card kpi col-3"><span>SLA vencido</span><strong>${overdue.length}</strong></div>
      <div class="card kpi col-3"><span>Valor previsto ativo</span><strong>${visibleValue}</strong></div>`;

    const filtered = filteredOperationCalls();
    if (!state.selectedCallId && filtered.length) state.selectedCallId = filtered[0].id;
    if (state.selectedCallId && (!state.calls[state.selectedCallId] || state.calls[state.selectedCallId].deletedAt)) state.selectedCallId = filtered[0] && filtered[0].id || null;
    const selectedCall = state.calls[state.selectedCallId] || null;
    $("opsCallsList").innerHTML = filtered.length ? filtered.map((c) => {
      const selected = c.id === state.selectedCallId ? " selected" : "";
      const vehicle = state.vehicles[c.vehicleId] || {};
      const driver = state.users[c.driverId] || {};
      const st = operationalStatus(c);
      const sla = slaInfo(c);
      const routeOk = c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise;
      const wa = phoneWhatsappUrl(c.phone, `JM Guinchos - chamado ${c.protocolo || c.id}`);
      return `<div class="ops-card${selected}" onclick="JM.app.selectOperationalCall('${esc(c.id)}')">
        <div class="actions" style="justify-content:space-between"><b>${esc(c.protocolo || c.cliente || c.id)}</b><span class="badge ${statusClass(st)}">${esc(st)}</span></div>
        <div class="small"><b>${esc(c.cliente || "Cliente")}</b> ${c.phone ? `· ${esc(c.phone)}` : ""}</div>
        <div class="muted small">${esc(c.source || "Particular")}${c.insurance ? ` · ${esc(c.insurance)}` : ""}${c.insuranceProtocol ? ` · Prot. ${esc(c.insuranceProtocol)}` : ""}</div>
        <div class="small">${esc(c.originLabel || c.origem && c.origem.label || "Origem não informada")} → ${esc(c.destLabel || c.destino && c.destino.label || "Destino aberto")}</div>
        <div class="muted small">Frota: ${esc(vehicle.placa || "sem veículo")} · Motorista: ${esc(driver.nome || driver.email || "sem motorista")}</div>
        <div class="actions ops-mini-actions">
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','motorista_a_caminho')">A caminho</button>
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','motorista_no_local')">No local</button>
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','em_transporte')">Transporte</button>
          <button class="btn good" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','finalizado')">Finalizar</button>
          ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" onclick="event.stopPropagation()">WhatsApp</a>` : ""}
        </div>
        <div>${routeOk ? '<span class="badge ok">Rota por ruas</span>' : '<span class="badge warn">Rota estimada</span>'} <span class="badge ${sla.className}">${esc(sla.label)}</span> ${String(c.priority).toLowerCase() === 'urgente' ? '<span class="badge danger">Urgente</span>' : ''}</div>
      </div>`;
    }).join("") : `<p class="muted">Nenhum chamado no filtro selecionado.</p>`;

    const vehicles = visibleRows(state.vehicles).sort((a, b) => String(a.placa || a.id || "").localeCompare(String(b.placa || b.id || "")));
    if (!state.selectedVehicleId && selectedCall && selectedCall.vehicleId) state.selectedVehicleId = selectedCall.vehicleId;
    $("opsVehiclesList").innerHTML = vehicles.length ? vehicles.map((v) => {
      const selected = v.id === state.selectedVehicleId ? " selected" : "";
      const age = minutesSince(v.lastTrackerAt || v.updatedAt);
      const online = v.location && age != null && age <= 10;
      const stale = v.location && age != null && age > 10;
      return `<div class="ops-card vehicle${selected}" onclick="JM.app.selectOperationalVehicle('${esc(v.id)}')">
        <div class="actions" style="justify-content:space-between"><b>${esc(v.placa || v.id)}</b><span class="badge ${online ? 'ok' : stale ? 'warn' : 'muted'}">${online ? 'online' : stale ? 'atrasado' : 'sem GPS'}</span></div>
        <div class="muted small">${esc(v.apelido || v.tipo || "Veículo")}</div>
        <div class="small">${v.location ? `Lat ${esc(v.location.lat)} · Lng ${esc(v.location.lng)}` : 'Sem posição do tracker'}</div>
        <div class="muted small">${age == null ? 'sem atualização' : 'última posição há ' + age + ' min'}</div>
      </div>`;
    }).join("") : `<p class="muted">Nenhum veículo cadastrado.</p>`;

    const hint = $("opsMapHint");
    if (hint) {
      const v = state.vehicles[state.selectedVehicleId];
      hint.textContent = selectedCall ? `Chamado selecionado: ${selectedCall.protocolo || selectedCall.cliente || selectedCall.id}. Veículo: ${v ? (v.placa || v.id) : 'não selecionado'}.` : "Selecione um chamado para acompanhar no mapa.";
    }
  }

  function selectOperationalCall(id) {
    state.selectedCallId = id;
    const call = state.calls[id];
    if (call && call.vehicleId) state.selectedVehicleId = call.vehicleId;
    renderOperations();
    refreshMaps();
  }

  function selectOperationalVehicle(id) {
    state.selectedVehicleId = id;
    renderOperations();
    refreshMaps();
  }

  async function assignSelectedVehicleToSelectedCall() {
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode despachar.", "danger");
    const callId = state.selectedCallId;
    const vehicleId = state.selectedVehicleId;
    if (!callId || !vehicleId) return toast("Selecione um chamado e um veículo.", "danger");
    const vehicle = state.vehicles[vehicleId];
    await db.collection("calls").doc(callId).update({
      vehicleId,
      status: "Despachado",
      statusKey: "despachado",
      dispatchedAt: new Date().toISOString(),
      dispatchedBy: state.user.uid,
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Veículo " + (vehicle && (vehicle.placa || vehicle.id) || vehicleId) + " despachado pela Central Operacional" })
    });
    toast("Veículo despachado para o chamado.", "ok");
  }

  function openSelectedCallRoute() {
    const call = state.calls[state.selectedCallId];
    if (!call) return toast("Selecione um chamado.", "danger");
    const url = routeForCall(call, state.selectedVehicleId);
    if (!url) return toast("Chamado sem rota/link. Preencha origem/destino.", "danger");
    window.open(url, "_blank");
  }

  async function copySelectedCallRoute() {
    const call = state.calls[state.selectedCallId];
    if (!call) return toast("Selecione um chamado.", "danger");
    const url = routeForCall(call, state.selectedVehicleId);
    if (!url) return toast("Chamado sem rota/link para copiar.", "danger");
    const text = `JM Guinchos - rota do chamado ${call.protocolo || call.id}
Cliente: ${call.cliente || ""}
Origem: ${call.originLabel || call.origem && call.origem.label || ""}
Destino: ${call.destLabel || call.destino && call.destino.label || ""}
Rota: ${url}`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Link da rota copiado.", "ok");
    } catch (_) {
      window.prompt("Copie o texto da rota:", text);
    }
  }

  function renderCalls() {
    const rows = visibleRows(state.calls).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) return $("callsTable").innerHTML = `<p class="muted">Nenhum chamado registrado.</p>`;
    $("callsTable").innerHTML = `<table><thead><tr><th>Protocolo</th><th>Cliente</th><th>Origem/Destino</th><th>Veículo</th><th>Status</th><th>Ações</th></tr></thead><tbody>` + rows.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      const driver = state.users[c.driverId] || {};
      const url = c.routeExternalUrl || c.routeUrl || mapsRouteUrl(c, vehicle);
      const km = routeKm(c, vehicle);
      const metric = c.routeDistanceText || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.distanceText || c.routeMetrics && c.routeMetrics.bestToOrigin && c.routeMetrics.bestToOrigin.distanceText || (km ? km.toFixed(1).replace(".", ",") + " km" : "Sem rota");
      const routeBadge = c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise ? `<br><span class="badge ok">Rota por ruas OSM</span>` : `<br><span class="badge warn">Fallback/estimada</span>`;
      const adminActions = canOwnCompany() ? `<button class="btn" onclick="JM.app.editCall('${esc(c.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteCall('${esc(c.id)}')">Excluir</button>` : "";
      const valueHtml = canSeeSensitiveFinance() ? `<br><b>${money(c.valor || 0)}</b>` : "";
      const sla = slaInfo(c);
      return `<tr>
        <td><b>${esc(c.protocolo || c.id)}</b><br><span class="muted small">${dateTime(c.createdAt)}</span></td>
        <td>${esc(c.cliente || "")}<br><span class="muted small">${esc(c.phone || "")}</span><br><span class="muted small">${esc(c.source || "Particular")}${c.insurance ? " · " + esc(c.insurance) : ""}${c.insuranceProtocol ? " · Prot. " + esc(c.insuranceProtocol) : ""}</span></td>
        <td><span class="small">${esc(c.originLabel || c.origem && c.origem.label || "-")}</span><br><span class="muted small">→ ${esc(c.destLabel || c.destino && c.destino.label || "-")}</span><br><b>${esc(metric)}</b>${routeBadge}${url ? `<br><a class="info small" target="_blank" href="${esc(url)}">Abrir rota no Maps</a>` : ""}</td>
        <td>${esc(vehicle.placa || "-")}<br><span class="muted small">${esc(driver.nome || driver.email || "Sem motorista")}</span></td>
        <td><span class="badge ${statusClass(c)}">${esc(operationalStatus(c))}</span>${valueHtml}<br><span class="badge ${sla.className}">${esc(sla.label)}</span></td>
        <td class="row-actions"><button class="btn good" onclick="JM.app.setCallStatus('${esc(c.id)}','despachado')">Despachar</button><button class="btn primary" onclick="JM.app.setCallStatus('${esc(c.id)}','motorista_a_caminho')">A caminho</button><button class="btn" onclick="JM.app.setCallStatus('${esc(c.id)}','finalizado')">Finalizar</button>${adminActions}</td>
      </tr>`;
    }).join("") + `</tbody></table>`;
  }

  $("callForm").onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = e.submitter || document.querySelector("#callForm button[type='submit']");
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode registrar chamado.", "danger");
    const originAddress = addressFromInputs("origin");
    const destinationAddress = addressFromInputs("destination");
    if (!originAddress || !originAddress.coords) {
      return toast("Antes de registrar, informe a origem por link de mapa ou latitude/longitude real.", "danger");
    }
    const customerPlate = $("callCustomerPlate") ? plateKey($("callCustomerPlate").value) : "";
    if (customerPlate && !isValidPlate(customerPlate)) {
      return toast("Placa do cliente inválida. Use ABC1234 ou ABC1D23.", "danger");
    }
    if (($("callSource") && /segur|assist/i.test($("callSource").value)) && $("callInsuranceProtocol") && !$("callInsuranceProtocol").value.trim()) {
      return toast("Chamado de seguradora/assistência precisa de protocolo para não perder o rastreio do acionamento.", "danger");
    }
    const best = bestSmartRoute();
    const routePoints = routePointsFromForm(true);
    const externalRouteUrl = currentExternalRouteUrl();
    const now = new Date().toISOString();
    setButtonBusy(submitBtn, true, "Salvando...");
    const baseData = {
      cliente: $("callClient").value.trim(),
      phone: $("callPhone").value.trim(),
      serviceType: $("callType").value,
      valor: parseMoney($("callPrice").value),
      source: $("callSource") ? $("callSource").value : "Particular",
      priority: $("callPriority") ? $("callPriority").value : "normal",
      insurance: $("callInsurance") ? $("callInsurance").value.trim() : "",
      insuranceProtocol: $("callInsuranceProtocol") ? $("callInsuranceProtocol").value.trim() : "",
      policy: $("callPolicy") ? $("callPolicy").value.trim() : "",
      claimNumber: $("callClaim") ? $("callClaim").value.trim() : "",
      policyNumber: $("callPolicyNumber") ? $("callPolicyNumber").value.trim() : "",
      billingStatus: $("callBillingStatus") ? $("callBillingStatus").value : "aberto",
      slaLimitAt: $("callSlaLimit") ? $("callSlaLimit").value : "",
      customerPlate,
      customerVehicle: $("callCustomerVehicle") ? $("callCustomerVehicle").value.trim() : "",
      extraKm: $("callExtraKm") ? parseMoney($("callExtraKm").value) : 0,
      vehicleId: $("callVehicle").value,
      driverId: $("callDriver").value,
      originLabel: originAddress.label,
      destLabel: destinationAddress && destinationAddress.label || "",
      origin: originAddress.coords,
      destination: destinationAddress && destinationAddress.coords || null,
      origem: originAddress,
      destino: destinationAddress || null,
      routeWaypoints: state.addresses.waypoints || [],
      routeExternalUrl: externalRouteUrl,
      routeProvider: externalRouteUrl ? "external_link" : "generated_google_maps_url",
      routeUrl: externalRouteUrl || (window.JM.googleMaps && window.JM.googleMaps.routeUrl(routePoints) || mapsRouteUrl(routePoints)),
      routeGeometry: best && best.fullRoute && best.fullRoute.geometry || null,
      routePrecision: best && best.fullRoute && best.fullRoute.source || "pending_map_render",
      routeDistanceText: best && best.fullRoute && best.fullRoute.distanceText || "",
      routeDurationText: best && best.fullRoute && best.fullRoute.durationText || "",
      routeMetrics: best ? {
        recommendedVehicleId: best.vehicle && best.vehicle.id || "",
        recommendedVehiclePlate: best.vehicle && best.vehicle.placa || "",
        bestToOrigin: best.toOrigin || null,
        serviceRoute: best.serviceRoute || null,
        fullRoute: best.fullRoute || null,
        calculatedAt: state.smartRoute && state.smartRoute.calculatedAt || new Date().toISOString(),
        algorithm: "tracker_position + openstreetmap_osrm_route + fallback_haversine + status_penalty"
      } : null,
      notes: $("callNotes").value.trim()
    };
    try {
      if (state.editingCallId) {
        if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode editar chamados.", "danger");
        const current = state.calls[state.editingCallId] || {};
        const nextKey = currentStatusKey(current) || ($("callDriver").value ? "despachado" : "aguardando_despacho");
        await db.collection("calls").doc(state.editingCallId).set(Object.assign({}, baseData, {
          status: statusLabel(nextKey),
          statusKey: nextKey,
          updatedAt: now,
          updatedBy: state.user.uid,
          timeline: arrayUnion({ at: now, by: personName(), text: "Chamado editado pela central" })
        }), { merge: true });
        resetCallForm();
        toast("Chamado atualizado.", "ok");
        return;
      }
      const protocolo = "JM-" + now.replace(/\D/g, "").slice(2, 14);
      const initialKey = $("callDriver").value ? "despachado" : "aguardando_despacho";
      await db.collection("calls").add(Object.assign({}, baseData, {
        protocolo,
        status: statusLabel(initialKey),
        statusKey: initialKey,
        createdAt: now,
        createdBy: state.user.uid,
        timeline: [{ at: now, by: personName(), text: "Chamado criado com endereço validado e rota inteligente" }]
      }));
      resetCallForm();
      toast("Chamado registrado com dados de rota.", "ok");
    } finally {
      setButtonBusy(submitBtn, false);
    }
  };

  async function setCallStatus(id, status) {
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode alterar status.", "danger");
    const call = state.calls[id];
    if (!call) return;
    const key = statusKey(status);
    const label = statusLabel(key);
    const updates = {
      status: label,
      statusKey: key,
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: personName(), text: "Status alterado para " + label })
    };
    if (key === "finalizado" && Number(call.valor || 0) > 0 && !call.financeCreated && canManageFinance()) {
      updates.financeCreated = true;
      await db.collection("transactions").add({
        type: "entrada",
        date: todayInput(),
        description: `Chamado ${call.protocolo || id} - ${call.cliente || ""}`,
        amount: Number(call.valor || 0),
        status: "A receber",
        callId: id,
        vehicleId: call.vehicleId || "",
        createdAt: new Date().toISOString(),
        createdBy: state.user.uid
      });
    }
    await db.collection("calls").doc(id).update(updates);
    toast("Status atualizado.", "ok");
  }

  function editCall(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode editar chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    state.editingCallId = id;
    showView("chamados");
    setValue("callClient", call.cliente || "");
    setValue("callPhone", call.phone || "");
    setValue("callType", call.serviceType || "Guincho");
    setValue("callPrice", call.valor || "");
    setValue("callSource", call.source || "Particular");
    setValue("callPriority", call.priority || "normal");
    setValue("callInsurance", call.insurance || "");
    setValue("callInsuranceProtocol", call.insuranceProtocol || "");
    setValue("callPolicy", call.policy || "");
    setValue("callClaim", call.claimNumber || "");
    setValue("callPolicyNumber", call.policyNumber || "");
    setValue("callSlaLimit", call.slaLimitAt || "");
    setValue("callBillingStatus", call.billingStatus || "aberto");
    setValue("callCustomerPlate", call.customerPlate || "");
    setValue("callCustomerVehicle", call.customerVehicle || "");
    setValue("callExtraKm", call.extraKm || "");
    setValue("callVehicle", call.vehicleId || "");
    setValue("callDriver", call.driverId || "");
    setValue("callNotes", call.notes || "");
    const originPoint = pointFrom(call.origem || call.origin);
    const destPoint = pointFrom(call.destino || call.destination);
    state.addresses.origin = {
      label: call.originLabel || call.origem && call.origem.label || "",
      coords: originPoint,
      source: call.origem && call.origem.source || "edit",
      resolvedAt: call.origem && call.origem.resolvedAt || new Date().toISOString()
    };
    state.addresses.destination = {
      label: call.destLabel || call.destino && call.destino.label || "",
      coords: destPoint,
      source: call.destino && call.destino.source || "edit",
      resolvedAt: call.destino && call.destino.resolvedAt || new Date().toISOString()
    };
    state.addresses.waypoints = Array.isArray(call.routeWaypoints) ? call.routeWaypoints : [];
    setValue("callRouteExternalUrl", call.routeExternalUrl || call.routeUrl || "");
    routeLinkStatus(call.routeExternalUrl ? "Link externo carregado do chamado." : "Sem link externo salvo neste chamado.", call.routeExternalUrl ? "ok" : "muted");
    setValue("callOriginLabel", state.addresses.origin.label);
    setValue("callOriginLat", originPoint && originPoint.lat);
    setValue("callOriginLng", originPoint && originPoint.lng);
    setValue("callDestLabel", state.addresses.destination.label);
    setValue("callDestLat", destPoint && destPoint.lat);
    setValue("callDestLng", destPoint && destPoint.lng);
    state.smartRoute = null;
    renderSmartRouteBox();
    setSubmitText("callForm", "Salvar alterações do chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.remove("hidden");
    toast("Edite o chamado e salve as alterações.", "ok");
  }

  async function deleteCall(id) {
    if (!canOwnCompany()) return toast("Somente gestor/dono pode excluir chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const label = call.protocolo || call.cliente || id;
    const reason = window.prompt(`Motivo para excluir o chamado ${label}:`, "Cancelamento operacional");
    if (reason === null) return;
    await softDeleteDoc("calls", id, call, reason);
    const linkedTransactions = await db.collection("transactions").where("callId", "==", id).get();
    const batch = db.batch();
    linkedTransactions.forEach((doc) => {
      batch.set(doc.ref, {
        deletedAt: new Date().toISOString(),
        deletedBy: state.user.uid,
        deletedByEmail: state.user.email,
        auditReason: "Vinculado ao chamado excluído: " + reason
      }, { merge: true });
    });
    await batch.commit();
    if (state.editingCallId === id) resetCallForm();
    toast("Chamado removido do painel com auditoria.", "ok");
  }

  function renderVehicles() {
    const rows = visibleRows(state.vehicles).sort((a, b) => String(a.placa || "").localeCompare(String(b.placa || "")));
    const txs = visibleRows(state.transactions);
    const maint = visibleRows(state.maintenance);
    $("fleetTable").innerHTML = rows.length ? `<table><thead><tr><th>Placa</th><th>Tipo</th><th>Status</th><th>Tracker</th><th>Resultado</th></tr></thead><tbody>` + rows.map((v) => {
      const age = minutesSince(v.lastTrackerAt || v.updatedAt);
      const gpsBadge = v.location && age != null && age <= 10 ? "ok" : v.location ? "warn" : "muted";
      const vehicleTx = txs.filter((t) => t.vehicleId === v.id);
      const entrada = vehicleTx.filter((t) => t.type === "entrada").reduce((s, t) => s + Number(t.amount || 0), 0);
      const saida = vehicleTx.filter((t) => t.type === "saida").reduce((s, t) => s + Number(t.amount || 0), 0);
      const manutencao = maint.filter((m) => m.vehicleId === v.id).reduce((s, m) => s + Number(m.cost || 0), 0);
      const lucro = entrada - saida - manutencao;
      return `<tr><td><b>${esc(v.placa || v.id)}</b><br><span class="muted small">${esc(v.apelido || "")}</span></td><td>${esc(v.tipo || "")}</td><td><span class="badge info">${esc(v.status || "")}</span></td><td><span class="badge ${gpsBadge}">${age == null ? "sem GPS" : "há " + age + " min"}</span><br><span class="muted small">${esc(v.trackerId || v.trackerDeviceId || "")}</span></td><td>${canSeeSensitiveFinance() ? `<b>${money(lucro)}</b><br><span class="muted small">Receita ${money(entrada)} · Custo ${money(saida + manutencao)}</span>` : "Restrito"}</td></tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum veículo.</p>`;

    $("vehicleCards").innerHTML = rows.length ? rows.map((v) => {
      const age = minutesSince(v.lastTrackerAt || v.updatedAt);
      return `<div class="card col-3"><b>${esc(v.placa || v.id)}</b><p class="muted small">${esc(v.apelido || v.tipo || "")}</p><span class="badge info">${esc(v.status || "")}</span><p class="small">${v.location ? `Lat ${esc(v.location.lat)}<br>Lng ${esc(v.location.lng)}<br>Última posição há ${age == null ? "?" : age} min` : "Sem posição do tracker"}</p></div>`;
    }).join("") : `<p class="muted">Sem frota cadastrada.</p>`;
  }

  $("vehicleForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/dono ou gerente pode editar frota.", "danger");
    const placa = plateKey($("vehiclePlate").value);
    if (!placa) return toast("Informe a placa.", "danger");
    if (!isValidPlate(placa)) return toast("Placa inválida. Use ABC1234 ou ABC1D23.", "danger");
    await db.collection("vehicles").doc(placa).set({
      placa,
      apelido: $("vehicleAlias").value.trim(),
      tipo: $("vehicleType").value.trim(),
      trackerId: $("vehicleTrackerId") ? $("vehicleTrackerId").value.trim() : placa,
      trackerDeviceId: $("vehicleTrackerId") ? $("vehicleTrackerId").value.trim() : "",
      status: $("vehicleStatus").value,
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    }, { merge: true });
    e.target.reset();
    toast("Veículo salvo.", "ok");
  };

  function renderMaintenance() {
    if (!$("maintenanceTable")) return;
    const rows = visibleRows(state.maintenance).sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
    $("maintenanceTable").innerHTML = rows.length ? `<table><thead><tr><th>Data</th><th>Veículo</th><th>Serviço</th><th>Status</th><th>Custo</th><th>Ações</th></tr></thead><tbody>` + rows.map((m) => {
      const vehicle = state.vehicles[m.vehicleId] || {};
      return `<tr><td>${esc(m.date || dateTime(m.createdAt))}</td><td>${esc(vehicle.placa || m.vehicleId || "-")}</td><td>${esc(m.description || "")}<br><span class="muted small">${esc(m.odometerKm ? m.odometerKm + " km" : "")}</span></td><td><span class="badge info">${esc(m.status || "aberta")}</span></td><td>${canSeeSensitiveFinance() ? money(m.cost || 0) : "Restrito"}</td><td class="row-actions"><button class="btn" onclick="JM.app.editMaintenance('${esc(m.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteMaintenance('${esc(m.id)}')">Excluir</button></td></tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhuma manutenção registrada.</p>`;
  }

  $("maintenanceForm") && ($("maintenanceForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/dono ou gerente pode lançar manutenção.", "danger");
    const now = new Date().toISOString();
    const payload = {
      vehicleId: $("maintenanceVehicle").value,
      date: $("maintenanceDate").value || todayInput(),
      description: $("maintenanceDesc").value.trim(),
      odometerKm: $("maintenanceKm").value.trim(),
      cost: parseMoney($("maintenanceCost").value),
      status: $("maintenanceStatus").value,
      updatedAt: now,
      updatedBy: state.user.uid
    };
    if (!payload.vehicleId || !payload.description) return toast("Informe veículo e serviço da manutenção.", "danger");
    if (state.editingMaintenanceId) {
      await db.collection("maintenance").doc(state.editingMaintenanceId).set(payload, { merge: true });
      toast("Manutenção atualizada.", "ok");
    } else {
      await db.collection("maintenance").add(Object.assign({ createdAt: now, createdBy: state.user.uid }, payload));
      toast("Manutenção registrada.", "ok");
    }
    resetMaintenanceForm();
  });

  function editMaintenance(id) {
    if (!canManageFleet()) return toast("Sem permissão para editar manutenção.", "danger");
    const item = state.maintenance[id];
    if (!item) return toast("Manutenção não encontrada.", "danger");
    state.editingMaintenanceId = id;
    setValue("maintenanceVehicle", item.vehicleId || "");
    setValue("maintenanceDate", item.date || "");
    setValue("maintenanceDesc", item.description || "");
    setValue("maintenanceKm", item.odometerKm || "");
    setValue("maintenanceCost", item.cost || "");
    setValue("maintenanceStatus", item.status || "aberta");
    setSubmitText("maintenanceForm", "Salvar alterações da manutenção");
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").classList.remove("hidden");
  }

  async function deleteMaintenance(id) {
    if (!canManageFleet()) return toast("Sem permissão para excluir manutenção.", "danger");
    const item = state.maintenance[id];
    if (!item) return toast("Manutenção não encontrada.", "danger");
    const reason = window.prompt("Motivo para excluir a manutenção:", "Correção de lançamento");
    if (reason === null) return;
    await softDeleteDoc("maintenance", id, item, reason);
    toast("Manutenção removida do painel com auditoria.", "ok");
  }

  function renderTeam() {
    const rows = visibleRows(state.users).sort((a, b) => String(a.nome || a.email || "").localeCompare(String(b.nome || b.email || "")));
    $("teamTable").innerHTML = rows.length ? `<table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((u) => {
        const canDelete = u.id !== state.user?.uid;
        const deleteButton = canDelete ? `<button class="btn danger" onclick="JM.app.deleteTeamMember('${esc(u.id)}')">Excluir</button>` : "";
        return `<tr><td><b>${esc(u.nome || "")}</b><br><span class="muted small">${esc(u.uid || u.id)}</span></td><td>${esc(u.email || "")}</td><td><span class="badge info">${esc(roleLabel(u.role))}</span></td><td>${u.active === false ? "Inativo" : "Ativo"}</td><td class="row-actions"><button class="btn" onclick="JM.app.editTeamMember('${esc(u.id)}')">Editar</button>${deleteButton}</td></tr>`;
      }).join("") +
      `</tbody></table>` : `<p class="muted">Nenhum usuário.</p>`;
  }

  function roleLabel(role) {
    const labels = {
      admin: "Gestor/Admin",
      gestor: "Gestor",
      gerente: "Gerente",
      auxiliar: "Auxiliar",
      atendente: "Atendente",
      finance: "Financeiro",
      driver: "Motorista",
      motorista: "Motorista"
    };
    return labels[normalizedRole(role)] || role || "Equipe";
  }

  function roleCanAccessJM(role) {
    return OFFICE_ROLES.includes(normalizedRole(role));
  }

  function editTeamMember(id) {
    if (!canManageTeam()) return toast("Somente gestor/dono pode editar funcionários.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    state.editingUserId = id;
    showView("equipe");
    setValue("teamName", user.nome || "");
    setValue("teamEmail", user.email || "");
    setValue("teamRole", normalizedRole(user.role) === "motorista" ? "driver" : normalizedRole(user.role || "driver"));
    setValue("teamActive", user.active === false ? "false" : "true");
    setValue("teamPass", "");
    if ($("teamEmail")) $("teamEmail").readOnly = true;
    if ($("teamPass")) $("teamPass").placeholder = "deixe em branco para manter";
    setSubmitText("teamForm", "Salvar alterações do funcionário");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.remove("hidden");
    toast("Edite o funcionário e salve as alterações.", "ok");
  }

  async function deleteTeamMember(id) {
    if (!canManageTeam()) return toast("Somente gestor/dono pode excluir funcionários.", "danger");
    if (id === state.user?.uid) return toast("Você não pode excluir o próprio usuário logado.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    const email = String(user.email || "").toLowerCase().trim();
    const reason = window.prompt(`Motivo para excluir ${user.nome || email || "este funcionário"} do painel JM:`, "Desligamento da equipe");
    if (reason === null) return;
    await writeAudit("delete", "users", id, user, reason);
    const batch = db.batch();
    batch.set(db.collection("users").doc(id), {
      active: false,
      deletedAt: new Date().toISOString(),
      deletedBy: state.user.uid,
      deletedByEmail: state.user.email,
      auditReason: reason
    }, { merge: true });
    if (email) {
      batch.delete(db.collection("managerAccess").doc(email));
      batch.delete(db.collection("driverAccess").doc(email));
    }
    await batch.commit();
    if (state.editingUserId === id) resetTeamForm();
    toast("Funcionário removido do painel. Remova o Auth manualmente ou por Cloud Function quando disponível.", "ok");
  }

  $("teamForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageTeam()) return toast("Somente gestor/dono pode editar equipe.", "danger");
    const email = $("teamEmail").value.trim().toLowerCase();
    const pass = $("teamPass").value;
    const selectedRole = normalizedRole($("teamRole").value || "driver");
    const isDriverRole = DRIVER_ROLES.includes(selectedRole);
    const isOfficeRole = roleCanAccessJM(selectedRole);
    const editingId = state.editingUserId;

    if (!isDriverRole && !isOfficeRole) return toast("Perfil inválido.", "danger");
    if (isDriverRole && await emailReservedForManager(email)) {
      return toast("Este e-mail está liberado como gestor/equipe interna. Ele não pode ser salvo como motorista.", "danger");
    }
    if (!editingId && !pass) return toast("Informe uma senha inicial para criar o usuário no Firebase Auth.", "danger");
    if (editingId && pass) return toast("Senha de usuário existente deve ser redefinida no Firebase Authentication.", "danger");

    let uid = editingId || uidSafe(email);
    if (pass) {
      if (pass.length < 6) return toast("Informe uma senha inicial com pelo menos 6 caracteres.", "danger");
      try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        uid = cred.user.uid;
        await secondaryAuth.signOut().catch(() => {});
      } catch (err) {
        if (err && err.code === "auth/email-already-in-use") {
          // Para gestor/gerente/atendente, o jm.html repara users/{uid} no primeiro login usando managerAccess/{email}.
          // Para motorista, o painel motorista tambem procura por e-mail e repara o UID quando possivel.
          uid = uidSafe(email);
        } else {
          return toast(friendlyAuthError(err), "danger");
        }
      }
    }

    const payload = {
      uid,
      nome: $("teamName").value.trim(),
      email,
      role: selectedRole,
      active: $("teamActive").value === "true",
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid,
      source: "jm-teamForm"
    };

    await db.collection("users").doc(uid).set(payload, { merge: true });
    const accessPayload = Object.assign({ createdAt: new Date().toISOString() }, payload);
    if (isOfficeRole) {
      await db.collection("managerAccess").doc(email).set(accessPayload, { merge: true });
      await db.collection("driverAccess").doc(email).delete().catch(() => {});
    }
    if (isDriverRole) {
      try {
        await db.collection("driverAccess").doc(email).set(accessPayload, { merge: true });
        await db.collection("managerAccess").doc(email).delete().catch(() => {});
      } catch (err) {
        toast("Motorista salvo, mas driverAccess foi bloqueado. Publique as novas firestore.rules para liberar o primeiro login.", "danger");
        return;
      }
    }
    resetTeamForm();
    toast(roleLabel(selectedRole) + " salvo na equipe.", "ok");
  };

  function renderDriverPanel() {
    const myCalls = Object.values(state.calls).filter((c) => isAdmin() || c.driverId === state.user?.uid);
    $("driverCalls").innerHTML = myCalls.length ? myCalls.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      const url = c.routeExternalUrl || c.routeUrl || mapsRouteUrl(c, vehicle);
      const metric = c.routeDistanceText || (routeKm(c, vehicle) ? routeKm(c, vehicle).toFixed(1).replace(".", ",") + " km" : "Sem rota");
      return `<div class="card" style="margin-bottom:12px"><div class="actions"><div><b>${esc(c.protocolo || c.cliente)}</b><br><span class="muted small">${esc(c.originLabel || "")} → ${esc(c.destLabel || "")}</span></div><span class="badge ${statusClass(c.status)}">${esc(c.status || "")}</span></div><p>${esc(c.notes || "")}</p><p><b>${esc(metric)}</b></p>${url ? `<a class="btn primary" target="_blank" href="${esc(url)}">Abrir rota</a>` : ""}</div>`;
    }).join("") : `<p class="muted">Nenhum chamado.</p>`;
  }

  $("expenseForm") && ($("expenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      callId: $("expenseCall").value,
      vehicleId: $("expenseVehicle").value,
      type: $("expenseType").value,
      amount: parseMoney($("expenseAmount").value),
      notes: $("expenseNotes").value.trim(),
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      createdAt: new Date().toISOString()
    };
    await db.collection("expenses").add(data);
    e.target.reset();
    toast("Despesa enviada para aprovação.", "ok");
  });

  function renderFinance() {
    if (!$("financeTable")) return;
    if (!canManageFinance()) {
      $("financeTable").innerHTML = `<p class="muted">Financeiro disponível somente para gestor/dono e perfil financeiro.</p>`;
      if ($("expenseApproval")) $("expenseApproval").innerHTML = "";
      return;
    }
    const rows = visibleRows(state.transactions).sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
    const entradas = rows.filter((t) => t.type === "entrada").reduce((s, t) => s + Number(t.amount || 0), 0);
    const saidas = rows.filter((t) => t.type === "saida").reduce((s, t) => s + Number(t.amount || 0), 0);
    $("financeTable").innerHTML = `<div class="finance-summary"><span>Receitas <b>${money(entradas)}</b></span><span>Despesas <b>${money(saidas)}</b></span><span>Lucro bruto <b>${money(entradas - saidas)}</b></span></div><table><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Vínculos</th><th>Status</th><th>Valor</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((t) => {
        const call = state.calls[t.callId] || {};
        const vehicle = state.vehicles[t.vehicleId] || {};
        const driver = state.users[t.driverId] || {};
        return `<tr><td>${esc(t.date || dateTime(t.createdAt))}</td><td>${esc(t.type || "")}</td><td>${esc(t.description || "")}<br><span class="muted small">${esc(t.category || "")}</span></td><td><span class="muted small">${esc(call.protocolo || t.callId || "Sem chamado")}<br>${esc(vehicle.placa || t.vehicleId || "Sem veículo")}<br>${esc(driver.nome || t.driverName || "")}</span></td><td>${esc(t.status || "")}</td><td><b>${money(t.amount || 0)}</b></td><td class="row-actions"><button class="btn" onclick="JM.app.editTransaction('${esc(t.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteTransaction('${esc(t.id)}')">Excluir</button></td></tr>`;
      }).join("") +
      `</tbody></table>${reportSignature()}`;
    const pending = visibleRows(state.expenses).filter((e) => e.status === "pendente");
    $("expenseApproval").innerHTML = pending.length ? `<table><thead><tr><th>Motorista</th><th>Tipo</th><th>Valor</th><th>Obs</th><th>Ações</th></tr></thead><tbody>` +
      pending.map((e) => `<tr>
        <td>${esc(e.driverName || e.driverId)}</td><td>${esc(e.type || "")}</td><td><b>${money(e.amount || 0)}</b></td>
        <td>${esc(e.notes || "")}${e.photoUrl ? `<br><a class="info" href="${esc(e.photoUrl)}" target="_blank">Comprovante</a>` : ""}</td>
        <td><button class="btn good" onclick="JM.app.approveExpense('${esc(e.id)}')">Aprovar</button><button class="btn danger" onclick="JM.app.rejectExpense('${esc(e.id)}')">Reprovar</button></td>
      </tr>`).join("") + `</tbody></table>` : `<p class="muted">Sem despesas pendentes de aprovação.</p>`;
  }

  $("financeForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFinance()) return toast("Somente gestor/dono ou financeiro pode lançar.", "danger");
    const payload = {
      type: $("finType").value,
      date: $("finDate").value,
      description: $("finDesc").value.trim(),
      amount: parseMoney($("finAmount").value),
      status: $("finStatus").value,
      category: $("finCategory") ? $("finCategory").value.trim() : "",
      callId: $("finCall") ? $("finCall").value : "",
      vehicleId: $("finVehicle") ? $("finVehicle").value : "",
      driverId: $("finDriver") ? $("finDriver").value : "",
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
    if (state.editingTransactionId) {
      await db.collection("transactions").doc(state.editingTransactionId).set(payload, { merge: true });
      toast("Lançamento atualizado.", "ok");
    } else {
      await db.collection("transactions").add(Object.assign({ createdAt: new Date().toISOString(), createdBy: state.user.uid }, payload));
      toast("Lançamento salvo.", "ok");
    }
    resetFinanceForm();
  };

  function editTransaction(id) {
    if (!canManageFinance()) return toast("Sem permissão para editar financeiro.", "danger");
    const tx = state.transactions[id];
    if (!tx) return toast("Lançamento não encontrado.", "danger");
    state.editingTransactionId = id;
    setValue("finType", tx.type || "entrada");
    setValue("finDate", tx.date || todayInput());
    setValue("finDesc", tx.description || "");
    setValue("finAmount", tx.amount || "");
    setValue("finStatus", tx.status || "Pendente");
    setValue("finCategory", tx.category || "");
    setValue("finCall", tx.callId || "");
    setValue("finVehicle", tx.vehicleId || "");
    setValue("finDriver", tx.driverId || "");
    setSubmitText("financeForm", "Salvar alterações financeiras");
    if ($("financeCancelEdit")) $("financeCancelEdit").classList.remove("hidden");
  }

  async function deleteTransaction(id) {
    if (!canOwnCompany()) return toast("Somente gestor/dono pode excluir financeiro.", "danger");
    const tx = state.transactions[id];
    if (!tx) return toast("Lançamento não encontrado.", "danger");
    const reason = window.prompt("Motivo para excluir o lançamento financeiro:", "Correção financeira");
    if (reason === null) return;
    await softDeleteDoc("transactions", id, tx, reason);
    if (state.editingTransactionId === id) resetFinanceForm();
    toast("Lançamento removido do painel com auditoria.", "ok");
  }

  async function approveExpense(id) {
    const expense = state.expenses[id];
    if (!expense || !canManageFinance()) return;
    await db.collection("expenses").doc(id).update({ status: "aprovado", approvedAt: new Date().toISOString(), approvedBy: state.user.uid });
    await db.collection("transactions").add({
      type: "saida",
      date: todayInput(),
      description: `Despesa ${expense.type || ""} - ${expense.driverName || ""}`,
      amount: Number(expense.amount || 0),
      status: "Pendente",
      expenseId: id,
      callId: expense.callId || "",
      vehicleId: expense.vehicleId || "",
      driverId: expense.driverId || "",
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    toast("Despesa aprovada e lançada no financeiro.", "ok");
  }

  async function rejectExpense(id) {
    if (!canManageFinance()) return;
    await db.collection("expenses").doc(id).update({ status: "reprovado", rejectedAt: new Date().toISOString(), rejectedBy: state.user.uid });
    toast("Despesa reprovada.", "ok");
  }

  function refreshMaps() {
    const active = document.querySelector(".view.active");
    window.JM_MAP_SETTINGS = activeMapSettings();
    const vehicles = Object.fromEntries(visibleRows(state.vehicles).map((v) => [v.id, v]));
    const calls = Object.fromEntries(visibleRows(state.calls).map((c) => [c.id, c]));
    if (!active) return;
    if (active.id === "view-dashboard") window.JM.mapa.renderFleetMap("dashboardMap", vehicles, calls);
    if (active.id === "view-operacao") window.JM.mapa.renderFleetMap("operationMap", vehicles, calls, { selectedCallId: state.selectedCallId, selectedVehicleId: state.selectedVehicleId, filter: state.operationFilter || "ativos" });
    if (active.id === "view-mapa") window.JM.mapa.renderFleetMap("fleetMap", vehicles, calls);
  }

  function registerFreshServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("service-worker.js?v=" + LOGIN_FLOW_VERSION).catch(() => {});
  }

  function bindRouteButtons() {
    if ($("btnGeocodeOrigin")) $("btnGeocodeOrigin").onclick = () => geocodeAddress("origin");
    if ($("btnGeocodeDest")) $("btnGeocodeDest").onclick = () => geocodeAddress("destination");
    if ($("btnUseCurrentLocation")) $("btnUseCurrentLocation").onclick = useCurrentLocationAsOrigin;
    if ($("btnSmartRoute")) $("btnSmartRoute").onclick = calculateSmartRoute;
    if ($("btnOpenGoogleRoute")) $("btnOpenGoogleRoute").onclick = openGoogleRouteFromForm;
    if ($("btnReadRouteLink")) $("btnReadRouteLink").onclick = readSharedRouteLink;
    if ($("btnSyncTrackerNow")) $("btnSyncTrackerNow").onclick = () => syncTrackerNow(true);
    if ($("callCancelEdit")) $("callCancelEdit").onclick = resetCallForm;
    if ($("teamCancelEdit")) $("teamCancelEdit").onclick = resetTeamForm;
    if ($("financeCancelEdit")) $("financeCancelEdit").onclick = resetFinanceForm;
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").onclick = resetMaintenanceForm;
  }

  function boot() {
    bindNavigation();
    bindRouteButtons();
    bindInputMasks();
    renderSmartRouteBox();
    initializeAddressTools();
    if ($("finDate")) $("finDate").value = todayInput();
    if ($("maintenanceDate")) $("maintenanceDate").value = todayInput();
    console.info("JM Guinchos login flow", LOGIN_FLOW_VERSION);
    registerFreshServiceWorker();
  }

  window.JM = window.JM || {};
  window.JM.app = {
    setCallStatus,
    selectOperationalCall,
    selectOperationalVehicle,
    assignSelectedVehicleToSelectedCall,
    openSelectedCallRoute,
    copySelectedCallRoute,
    editCall,
    deleteCall,
    editTeamMember,
    deleteTeamMember,
    editTransaction,
    deleteTransaction,
    editMaintenance,
    deleteMaintenance,
    approveExpense,
    rejectExpense,
    applySmartVehicle,
    calculateSmartRoute,
    readSharedRouteLink,
    syncTrackerNow,
    state
  };
  boot();
}());
