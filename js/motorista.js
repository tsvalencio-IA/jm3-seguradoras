(function () {
  "use strict";

  const { $, esc, parseMoney, toast, statusClass, routeKm, mapsRouteUrl, statusKey, statusLabel, isFinalStatus, setupCollapsiblePanels } = window.JM.utils;
  const { auth, db, arrayUnion } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const DRIVER_FLOW_VERSION = "jm-v19-3-provas-minimizacao-definitiva";
  const state = { user: null, profile: null, calls: {}, vehicles: {}, expenses: {}, settings: {} };
  const unsubscribers = [];
  let driverLocationWatchId = null;
  const PROOF_STAGES = ["retirada", "carregamento", "transporte", "entrega", "finalizacao"];
  const REQUIRED_PHOTOS = [
    { key: "front", input: "proofPhotoFront", label: "Frente" },
    { key: "rear", input: "proofPhotoRear", label: "Traseira" },
    { key: "right", input: "proofPhotoRight", label: "Lateral direita" },
    { key: "left", input: "proofPhotoLeft", label: "Lateral esquerda" },
    { key: "dashboard", input: "proofPhotoDashboard", label: "Painel / odômetro" },
    { key: "damage", input: "proofPhotoDamage", label: "Avarias" },
    { key: "final", input: "proofPhotoFinal", label: "Comprovante final" }
  ];
  let signaturePad = null;

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "Usuário ou senha inválidos.";
    return "Acesso negado: " + (err && err.message || "falha de autenticação");
  }

  function stopListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
  }

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isDriverRole(role) {
    return ["driver", "motorista"].includes(normalizedRole(role));
  }

  function visibleRows(rows) {
    return Object.values(rows || {}).filter((row) => row && !row.deletedAt);
  }

  function proofPhotos(call) {
    return Array.isArray(call && call.proofPhotos) ? call.proofPhotos.filter(Boolean) : [];
  }

  function hasPhotoType(call, type) {
    return proofPhotos(call).some((photo) => photo && photo.type === type && photo.cloudinaryUrl);
  }

  function hasCompleteChecklist(call) {
    const checklist = call && call.proofChecklist || {};
    return PROOF_STAGES.every((stage) => checklist[stage] && checklist[stage].status && checklist[stage].status !== "pendente");
  }

  function hasSignature(call) {
    return !!(call && call.customerSignature && (call.customerSignature.signatureUrl || call.customerSignature.cloudinaryUrl) && call.customerSignature.acceptedText);
  }

  function proofStatusFor(call) {
    if (!call) return "pendente";
    const checklist = call.proofChecklist || {};
    const requiredPhotos = requiredProofPhotosForChecklist(checklist);
    const missingPhotos = requiredPhotos.filter((photo) => !hasPhotoType(call, photo.key)).length;
    if (missingPhotos === 0 && hasCompleteChecklist(call) && hasSignature(call)) return "completo";
    if (proofPhotos(call).length || call.proofChecklist || call.customerSignature) return "parcial";
    return "pendente";
  }

  function proofBadge(call) {
    const status = call && (call.proofStatus || proofStatusFor(call)) || "pendente";
    const cls = status === "revisado" || status === "completo" ? "ok" : status === "parcial" ? "warn" : "danger";
    return `<span class="badge ${cls}">Provas: ${esc(status)}</span>`;
  }

  function callDisplayName(call) {
    if (!call) return "";
    return call.insurance || call.billingParty || call.cliente || call.customerName || call.protocolo || "";
  }

  function callProtocolLabel(call, fallbackId) {
    return call && (call.protocolo || call.insuranceProtocol || call.id) || fallbackId || "";
  }

  function normalizeCostText(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }

  function isVehicleCostType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /combustivel|diesel|gasolina|etanol|arla|pedagio|estacionamento|lavagem|alimentacao|manutenc|revis|oleo|pneu|freio|suspens|eletric|borrachar|mecanica|motor|cambio|guincho|munck|plataforma|peca|pecas/.test(text);
  }

  function isMaintenanceExpenseType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /manutenc|revis|oleo|pneu|freio|suspens|eletric|mecanica|motor|cambio|guincho|munck|plataforma|borrachar|peca|pecas/.test(text);
  }

  function vehicleCostKind(type, notes) {
    return isMaintenanceExpenseType(type, notes) ? "maintenance" : isVehicleCostType(type, notes) ? "operational" : "general";
  }


  function syncDriverExpenseContext() {
    const callId = $("driverExpenseCall") && $("driverExpenseCall").value;
    const call = callId && state.calls[callId];
    const vehicleSelect = $("driverExpenseVehicle");
    const box = $("driverExpenseContext");
    if (!vehicleSelect) return;
    if (call && call.vehicleId) {
      vehicleSelect.value = call.vehicleId;
      const vehicle = state.vehicles[call.vehicleId] || {};
      if (box) box.innerHTML = `Vinculado automaticamente ao chamado <b>${esc(callProtocolLabel(call, callId))}</b>, veículo <b>${esc(vehicle.placa || call.vehicleId)}</b> e pagador <b>${esc(callDisplayName(call) || "não informado")}</b>.`;
    } else if (box) {
      box.textContent = callId ? "Chamado sem veículo definido. Selecione o veículo manualmente." : "Escolha um chamado para puxar veículo, protocolo e seguradora automaticamente.";
    }
  }

  function mergeNonEmpty(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      out[key] = value;
    });
    return out;
  }

  function activeCloudinaryConfig() {
    return mergeNonEmpty(cfg.cloudinary || {}, state.settings.cloudinary || {});
  }

  function setProofSubmitStatus(message, type, alsoToast) {
    const box = $("driverProofStatus");
    const kind = type || "info";
    if (box) {
      box.textContent = message;
      box.className = "wide proof-submit-status " + kind;
      box.hidden = false;
      try { box.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
    }
    if (alsoToast !== false) toast(message, kind === "success" ? "ok" : kind);
  }

  function requiredProofPhotosForChecklist(checklist) {
    const hasAvaria = Object.values(checklist || {}).some((item) => item && String(item.status || "").toLowerCase().includes("avaria"));
    return REQUIRED_PHOTOS.filter((photo) => photo.key !== "damage" || hasAvaria);
  }

  function proofPhotoLabelList(photos) {
    return (photos || []).map((photo) => photo.label || photo.key).join(", ");
  }

  function imageFileToCanvas(file, maxSide, quality) {
    return new Promise((resolve) => {
      if (!file || !/^image\//i.test(file.type || "")) return resolve(file);
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          const biggest = Math.max(width, height);
          if (!width || !height || biggest <= maxSide) {
            URL.revokeObjectURL(url);
            return resolve(file);
          }
          const scale = maxSide / biggest;
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url);
            if (!blob) return resolve(file);
            const name = String(file.name || "foto.jpg").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
            resolve(new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }));
          }, "image/jpeg", quality || 0.82);
        } catch (_) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function getCurrentPositionSafe() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || null,
          capturedAt: new Date().toISOString()
        }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 }
      );
    });
  }

  function setupSignaturePad() {
    const canvas = $("signatureCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#e6edf7";
    signaturePad = { canvas, ctx, drawing: false, dirty: false };
    function point(evt) {
      const rect = canvas.getBoundingClientRect();
      const touch = evt.touches && evt.touches[0];
      const src = touch || evt;
      return {
        x: (src.clientX - rect.left) * (canvas.width / rect.width),
        y: (src.clientY - rect.top) * (canvas.height / rect.height)
      };
    }
    function start(evt) {
      evt.preventDefault();
      const p = point(evt);
      signaturePad.drawing = true;
      signaturePad.dirty = true;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }
    function move(evt) {
      if (!signaturePad.drawing) return;
      evt.preventDefault();
      const p = point(evt);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    function end(evt) {
      if (evt) evt.preventDefault();
      signaturePad.drawing = false;
    }
    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end, { passive: false });
    if ($("clearSignatureBtn")) $("clearSignatureBtn").onclick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      signaturePad.dirty = false;
    };
  }

  function signatureBlob() {
    return new Promise((resolve) => {
      if (!signaturePad || !signaturePad.dirty) return resolve(null);
      signaturePad.canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  function normalizeDriverProfile(user, data) {
    const profile = Object.assign({}, data || {}, {
      uid: user.uid,
      email: String(user.email || "").toLowerCase(),
      role: normalizedRole(data && data.role || "driver") || "driver",
      active: data && data.active !== false
    });
    if (!isDriverRole(profile.role)) {
      throw new Error("Este login existe, mas não está marcado como motorista.");
    }
    if (profile.active === false) {
      throw new Error("Seu usuário não está ativo no cadastro da JM Guinchos.");
    }
    return profile;
  }

  async function repairDriverFromAccess(user) {
    const email = String(user.email || "").toLowerCase().trim();
    if (!email) return null;
    const permitSnap = await db.collection("driverAccess").doc(email).get();
    if (!permitSnap.exists) return null;
    const permit = permitSnap.data() || {};
    const profile = normalizeDriverProfile(user, {
      nome: permit.nome || user.displayName || email.split("@")[0],
      role: permit.role || "driver",
      active: permit.active !== false,
      source: "motorista-driverAccessRepair"
    });
    const payload = Object.assign({}, permit, profile, {
      repairedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("users").doc(user.uid).set(payload, { merge: true });
    return { id: user.uid, ...payload };
  }

  async function loadProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    if (snap.exists) {
      return { id: user.uid, ...normalizeDriverProfile(user, snap.data()) };
    }

    const repairedByAccess = await repairDriverFromAccess(user);
    if (repairedByAccess) {
      return repairedByAccess;
    }

    // Reparo para e-mail criado no Auth antes de existir users/{uid}.
    const byEmail = await db.collection("users").where("email", "==", String(user.email || "").toLowerCase().trim()).limit(1).get();
    if (!byEmail.empty) {
      const doc = byEmail.docs[0];
      const data = normalizeDriverProfile(user, doc.data() || {});
      const repaired = Object.assign({}, data, {
        uid: user.uid,
        email: user.email,
        repairedUidAt: new Date().toISOString()
      });
      await ref.set(repaired, { merge: true });
      return { id: user.uid, ...repaired };
    }
    throw new Error("Seu motorista existe no Auth, mas não está liberado em driverAccess. Recrie/atualize o motorista no jm.html depois de publicar as regras novas.");
  }

  function startListeners() {
    stopListeners();
    unsubscribers.push(db.collection("vehicles").onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.vehicles = rows;
      render();
    }));
    unsubscribers.push(db.collection("calls").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.calls = rows;
      render();
    }));
    unsubscribers.push(db.collection("expenses").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.expenses = rows;
      render();
    }));
    unsubscribers.push(db.collection("settings").doc("integrations").onSnapshot((snap) => {
      state.settings = snap.exists ? snap.data() : {};
    }));
  }

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    state.user = user || null;
    if (!user) {
      $("driverLoginView").classList.remove("hidden");
      $("driverAppView").classList.add("hidden");
      return;
    }
    try {
      state.profile = await loadProfile(user);
      $("driverLoginView").classList.add("hidden");
      $("driverAppView").classList.remove("hidden");
      $("driverUserBox").textContent = `${state.profile.nome || user.email} - ${state.profile.role || "motorista"}`;
      startListeners();
    } catch (err) {
      $("driverLoginError").textContent = err.message;
      await auth.signOut();
    }
  });

  $("driverLoginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("driverLoginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("driverLoginEmail").value.trim(), $("driverLoginPass").value);
    } catch (err) {
      $("driverLoginError").textContent = friendlyAuthError(err);
    }
  };

  $("driverLogoutBtn").onclick = () => auth.signOut();
  $("driverRefreshBtn").onclick = () => render();
  if ($("driverExpenseCall")) $("driverExpenseCall").onchange = syncDriverExpenseContext;
  if ($("driverStartLocationBtn")) $("driverStartLocationBtn").onclick = startDriverPhoneLocation;
  if ($("driverStopLocationBtn")) $("driverStopLocationBtn").onclick = stopDriverPhoneLocation;

  function activeCalls() {
    return visibleRows(state.calls).filter((c) => !isFinalStatus(c));
  }

  function render() {
    renderCalls();
    renderExpenseSelects();
    window.JM_MAP_SETTINGS = (window.JM_CONFIG && window.JM_CONFIG.map) || {};
    window.JM.mapa.renderFleetMap("driverMap", state.vehicles, state.calls);
  }

  function renderCalls() {
    const calls = activeCalls().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    $("driverCallsBox").innerHTML = calls.length ? calls.map((call) => {
      const vehicle = state.vehicles[call.vehicleId] || {};
      const url = call.routeExternalUrl || call.routeUrl || mapsRouteUrl(call, vehicle);
      const km = routeKm(call, vehicle);
      const metric = call.routeDistanceText || call.routeMetrics && call.routeMetrics.fullRoute && call.routeMetrics.fullRoute.distanceText || (km ? km.toFixed(1).replace(".", ",") + " km estimados" : "aguardando coordenadas");
      const routeBadge = call.routePrecision === "osrm_openstreetmap" || call.routeMetrics && call.routeMetrics.fullRoute && call.routeMetrics.fullRoute.isPrecise ? `<span class="badge ok">Rota por ruas OSM</span>` : `<span class="badge warn">Rota estimada/fallback</span>`;
      const proof = proofBadge(call);
      return `<div class="card" style="margin-bottom:10px">
        <div class="actions" style="justify-content:space-between">
          <div><b>${esc(call.protocolo || call.id)}</b><br><span class="muted small">${esc(call.cliente || "")} - ${esc(vehicle.placa || "")}</span></div>
          <span class="badge ${statusClass(call)}">${esc(statusLabel(call))}</span>
        </div>
        <p class="small"><b>Origem:</b> ${esc(call.origem?.label || call.originLabel || "-")}<br><b>Destino:</b> ${esc(call.destino?.label || call.destLabel || "-")}<br><b>Rota:</b> ${esc(metric)} ${routeBadge} ${proof}<br><b>Acionamento:</b> ${esc(call.source || "Particular")}${call.insurance ? " · " + esc(call.insurance) : ""}${call.insuranceProtocol ? " · Prot. " + esc(call.insuranceProtocol) : ""}<br><b>Veículo cliente:</b> ${esc(call.customerPlate || "-")} ${call.customerVehicle ? "· " + esc(call.customerVehicle) : ""}</p>
        <div class="actions">
          ${url ? `<a class="btn good" target="_blank" href="${esc(url)}">Abrir rota no Maps</a>` : ""}
          <button class="btn primary" onclick="JM.motorista.setStatus('${esc(call.id)}','motorista_a_caminho')">A caminho</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','motorista_no_local')">No local</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','veiculo_carregado')">Carregado</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','entregue')">Entregue</button>
          <button class="btn warn" onclick="JM.motorista.startLocationForCall('${esc(call.id)}')">Ativar GPS deste chamado</button>
          <button class="btn good" onclick="JM.motorista.setStatus('${esc(call.id)}','finalizado')">Finalizar</button>
        </div>
      </div>`;
    }).join("") + `<div class="report-signature">Powered by thIAguinho Soluções Digitais</div>` : `<p class="muted">Nenhum chamado vinculado ao seu usuário.</p>`;
  }

  function renderExpenseSelects() {
    const currentCall = $("driverExpenseCall") && $("driverExpenseCall").value || "";
    const currentVehicle = $("driverExpenseVehicle") && $("driverExpenseVehicle").value || "";
    const currentLocationCall = $("driverLocationCall") && $("driverLocationCall").value || "";
    const callOptions = activeCalls().map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join("");
    $("driverExpenseCall").innerHTML = `<option value="">Sem chamado</option>` + callOptions;
    if (currentCall && state.calls[currentCall]) $("driverExpenseCall").value = currentCall;
    if ($("driverReportCall")) $("driverReportCall").innerHTML = `<option value="">Selecione</option>` + callOptions;
    if ($("driverProofCall")) $("driverProofCall").innerHTML = `<option value="">Selecione</option>` + callOptions;
    if ($("driverLocationCall")) $("driverLocationCall").innerHTML = `<option value="">Selecione</option>` + callOptions;
    if (currentLocationCall && state.calls[currentLocationCall] && $("driverLocationCall")) $("driverLocationCall").value = currentLocationCall;
    $("driverExpenseVehicle").innerHTML = `<option value="">Selecione</option>` + visibleRows(state.vehicles).map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)}</option>`).join("");
    if (currentVehicle && state.vehicles[currentVehicle]) $("driverExpenseVehicle").value = currentVehicle;
    syncDriverExpenseContext();
  }

  function setDriverLocationStatus(message, type) {
    const box = $("driverLocationStatus");
    if (!box) return;
    box.textContent = message;
    box.className = "wide small " + (type || "muted");
  }

  function stopDriverPhoneLocation() {
    if (driverLocationWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(driverLocationWatchId);
    }
    driverLocationWatchId = null;
    setDriverLocationStatus("Localização do celular desligada.", "muted");
  }

  async function saveDriverLocationPoint(callId, pos) {
    const call = state.calls[callId] || {};
    const vehicleId = call.vehicleId || call.vehicle || call.truckId || "";
    const point = {
      lat: Number(pos.coords.latitude),
      lng: Number(pos.coords.longitude),
      accuracy: pos.coords.accuracy || null,
      altitude: pos.coords.altitude || null,
      heading: pos.coords.heading || null,
      speed: pos.coords.speed || null,
      source: "driver_phone_geolocation",
      capturedAt: new Date().toISOString(),
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      callId,
      vehicleId
    };

    const callPayload = {
      driverPhoneLocation: point,
      mobileLocation: point,
      phoneLocationActive: true,
      phoneLocationUpdatedAt: point.capturedAt,
      gpsSource: "driver_phone",
      updatedAt: point.capturedAt
    };

    await db.collection("calls").doc(callId).set(callPayload, { merge: true });

    if (vehicleId) {
      try {
        await db.collection("vehicles").doc(vehicleId).set({
          location: point,
          mobileLocation: point,
          driverPhoneLocation: point,
          gpsSource: "driver_phone",
          trackerStatus: "GPS celular motorista",
          lastPhoneGpsAt: point.capturedAt,
          lastTrackerAt: point.capturedAt,
          activeCallId: callId,
          activeDriverId: state.user.uid,
          activeDriverName: state.profile.nome || state.user.email,
          updatedAt: point.capturedAt,
          updatedBy: state.user.uid
        }, { merge: true });
      } catch (err) {
        console.warn("GPS do celular foi salvo no chamado, mas o veículo recusou atualização. Publique o firestore.rules da versão V19.1.", err);
      }
    }

    const vehicleLabel = vehicleId ? " · veículo atualizado" : " · chamado sem veículo vinculado";
    setDriverLocationStatus("Localização ativa: " + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + " · precisão " + Math.round(point.accuracy || 0) + "m" + vehicleLabel, vehicleId ? "ok" : "warn");
    return point;
  }

  async function startDriverPhoneLocation(callIdOverride) {
    if (!navigator.geolocation) return toast("Este celular/navegador não liberou geolocalização.", "danger");
    const callId = callIdOverride || $("driverLocationCall") && $("driverLocationCall").value;
    const call = callId && state.calls[callId];
    if (!call) return toast("Selecione um chamado ativo para enviar a localizacao do celular.", "danger");
    if ($("driverLocationCall")) $("driverLocationCall").value = callId;
    stopDriverPhoneLocation();
    setDriverLocationStatus("Solicitando permissao de localizacao do celular...", "warn");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await saveDriverLocationPoint(callId, pos);
        toast("Localizacao do celular enviada para a central.", "ok");
      } catch (err) {
        setDriverLocationStatus("Falha ao salvar localizacao no Firestore: " + (err && err.message || "permissao negada"), "danger");
      }
    }, (err) => {
      setDriverLocationStatus("Autorize a localizacao do celular no navegador. Detalhe: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 });
    driverLocationWatchId = navigator.geolocation.watchPosition(async (pos) => {
      try {
        await saveDriverLocationPoint(callId, pos);
      } catch (err) {
        setDriverLocationStatus("Falha ao enviar localização: " + (err && err.message || "permissão negada"), "danger");
      }
    }, (err) => {
      setDriverLocationStatus("GPS em espera: autorize localizacao ou aguarde sinal melhor. Detalhe: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 });
  }

  async function setStatus(id, status) {
    const call = state.calls[id];
    if (!call) return;
    const key = statusKey(status);
    const label = statusLabel(key);
    if (key === "finalizado" && !["completo", "revisado"].includes(call.proofStatus || proofStatusFor(call))) {
      return toast("Antes de finalizar, salve checklist, fotos obrigatórias e assinatura/aceite do cliente em Provas do atendimento.", "danger");
    }
    await db.collection("calls").doc(id).update({
      status: label,
      statusKey: key,
      closedAt: key === "finalizado" ? new Date().toISOString() : call.closedAt || "",
      closedBy: key === "finalizado" ? state.user.uid : call.closedBy || "",
      closedByEmail: key === "finalizado" ? state.user.email : call.closedByEmail || "",
      locked: key === "finalizado" ? true : call.locked || false,
      phoneLocationActive: key === "finalizado" ? false : call.phoneLocationActive || false,
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista alterou status para " + label })
    });
    if (key === "finalizado") stopDriverPhoneLocation();
    toast("Chamado atualizado.", "ok");
  }

  async function uploadToCloudinaryAsset(file, options) {
    const cloud = activeCloudinaryConfig();
    if (!file) return null;
    if (!cloud.cloudName || !cloud.uploadPreset) {
      throw new Error("Cloudinary não configurado: salve cloudName e uploadPreset no superadmin antes de enviar fotos.");
    }
    const preparedFile = await imageFileToCanvas(file, 1600, 0.82);
    const endpoint = `https://api.cloudinary.com/v1_1/${cloud.cloudName}/upload`;

    function buildForm(withFolder) {
      const form = new FormData();
      if (options && options.fileName) form.append("file", preparedFile, options.fileName);
      else form.append("file", preparedFile);
      form.append("upload_preset", cloud.uploadPreset);
      if (withFolder) {
        const folder = [cloud.folder || "jm-guinchos", options && options.folder].filter(Boolean).join("/");
        if (folder) form.append("folder", folder);
      }
      return form;
    }

    async function send(withFolder) {
      const controller = window.AbortController ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 45000) : null;
      let response;
      try {
        response = await fetch(endpoint, { method: "POST", body: buildForm(withFolder), signal: controller && controller.signal });
      } finally {
        if (timer) clearTimeout(timer);
      }
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const detail = data && data.error && data.error.message ? data.error.message : "Cloudinary recusou o upload.";
        const err = new Error(detail);
        err.status = response.status;
        throw err;
      }
      return data || {};
    }

    let data;
    try {
      data = await send(true);
    } catch (err) {
      const msg = String(err && err.message || "").toLowerCase();
      if (err && err.name === "AbortError") throw new Error("Tempo esgotado ao enviar para o Cloudinary. Teste com uma foto menor ou confira a internet do celular.");
      if (/folder|public_id|parameter|not allowed|disallowed|unsigned|preset/i.test(msg)) {
        data = await send(false);
      } else {
        throw err;
      }
    }

    if (!data.secure_url && !data.url) throw new Error("Cloudinary respondeu, mas não devolveu URL do arquivo.");
    return {
      cloudinaryUrl: data.secure_url || data.url || "",
      publicId: data.public_id || "",
      resourceType: data.resource_type || "image",
      bytes: data.bytes || 0,
      format: data.format || "",
      uploadedAt: new Date().toISOString()
    };
  }

  async function uploadToCloudinary(file) {
    const asset = await uploadToCloudinaryAsset(file);
    return asset && asset.cloudinaryUrl || "";
  }

  $("driverExpenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const photo = $("driverExpensePhoto").files && $("driverExpensePhoto").files[0];
    let photoUrl = "";
    try { photoUrl = await uploadToCloudinary(photo); } catch (err) { toast("Foto não enviada: " + err.message, "danger"); }
    const callId = $("driverExpenseCall").value;
    const call = callId && state.calls[callId] || null;
    const vehicleId = call && call.vehicleId || $("driverExpenseVehicle").value;
    const expenseType = $("driverExpenseType").value;
    const expenseNotes = $("driverExpenseNotes").value.trim();
    if (isVehicleCostType(expenseType, expenseNotes) && !vehicleId) return toast("Despesa de frota precisa estar vinculada a um veículo. Selecione o caminhão/guincho antes de enviar.", "danger");
    if (callId && !vehicleId) return toast("Este chamado ainda não tem veículo. Selecione o veículo antes de enviar a despesa.", "danger");
    await db.collection("expenses").add({
      callId,
      vehicleId,
      type: expenseType,
      amount: parseMoney($("driverExpenseAmount").value),
      notes: expenseNotes,
      photoUrl,
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      customerId: call && call.customerId || "",
      billingParty: callDisplayName(call),
      protocol: callProtocolLabel(call, callId),
      insurance: call && call.insurance || "",
      insuranceProtocol: call && call.insuranceProtocol || "",
      customerPlate: call && call.customerPlate || "",
      sourceType: "driver_expense",
      vehicleCost: !!vehicleId,
      vehicleCostKind: vehicleCostKind(expenseType, expenseNotes),
      vehicleCostCategory: expenseType || "Despesa motorista",
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    e.target.reset();
    syncDriverExpenseContext();
    toast("Despesa enviada para aprovação já vinculada ao chamado, veículo e pagador.", "ok");
  };

  $("driverReportForm") && ($("driverReportForm").onsubmit = async (e) => {
    e.preventDefault();
    const callId = $("driverReportCall").value;
    const call = state.calls[callId];
    if (!call) return toast("Selecione um chamado ativo para enviar relatório.", "danger");
    const photo = $("driverReportPhoto").files && $("driverReportPhoto").files[0];
    let photoUrl = "";
    try { photoUrl = await uploadToCloudinary(photo); } catch (err) { toast("Foto não enviada: " + err.message, "danger"); }
    await db.collection("calls").doc(callId).update({
      driverReports: arrayUnion({
        at: new Date().toISOString(),
        by: state.profile.nome || state.user.email,
        checklist: $("driverReportChecklist").value,
        notes: $("driverReportNotes").value.trim(),
        photoUrl
      }),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista enviou relatório/checklist" }),
      updatedAt: new Date().toISOString()
    });
    e.target.reset();
    toast("Relatório enviado para a central.", "ok");
  });

  $("driverProofForm") && ($("driverProofForm").onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.submitter || document.querySelector("#driverProofForm button[type='submit']");
    const callId = $("driverProofCall") && $("driverProofCall").value;
    const call = callId && state.calls[callId];
    if (!call) return setProofSubmitStatus("Selecione um chamado ativo para salvar as provas.", "danger");

    const acceptedText = $("signatureAcceptedText").value.trim();
    if (!acceptedText) return setProofSubmitStatus("O aceite textual é obrigatório para registrar as provas do atendimento.", "danger");
    const hasNewSignature = !!(signaturePad && signaturePad.dirty);
    const hasExistingSignature = hasSignature(call);
    const signatureMissing = !hasNewSignature && !hasExistingSignature;

    const checklist = {
      retirada: { status: $("proofStageRetirada").value, label: "Retirada" },
      carregamento: { status: $("proofStageCarregamento").value, label: "Carregamento" },
      transporte: { status: $("proofStageTransporte").value, label: "Transporte" },
      entrega: { status: $("proofStageEntrega").value, label: "Entrega" },
      finalizacao: { status: $("proofStageFinalizacao").value, label: "Finalização" },
      notes: $("proofChecklistNotes").value.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
    if (PROOF_STAGES.some((stage) => checklist[stage].status === "pendente")) {
      return setProofSubmitStatus("Nenhuma etapa do checklist pode ficar pendente para fechar o atendimento.", "danger");
    }

    const requiredPhotos = requiredProofPhotosForChecklist(checklist);
    const existingPhotos = proofPhotos(call);
    const missingPhoto = requiredPhotos.find((photo) => {
      const input = $(photo.input);
      return !hasPhotoType(call, photo.key) && !(input && input.files && input.files[0]);
    });
    if (missingPhoto) {
      return setProofSubmitStatus("Foto obrigatória faltando: " + missingPhoto.label + ".", "danger");
    }

    const cloud = activeCloudinaryConfig();
    if (!cloud.cloudName || !cloud.uploadPreset) {
      return setProofSubmitStatus("Cloudinary não configurado. Entre no superadmin e salve cloudName e uploadPreset antes de enviar fotos e assinatura.", "danger");
    }

    submit.disabled = true;
    submit.dataset.originalText = submit.dataset.originalText || submit.textContent;
    submit.textContent = "Enviando provas...";
    setProofSubmitStatus("Iniciando envio das provas. Não feche esta tela.", "info", false);

    try {
      const gps = await getCurrentPositionSafe();
      const uploadedPhotos = [];
      for (let i = 0; i < requiredPhotos.length; i += 1) {
        const photo = requiredPhotos[i];
        const input = $(photo.input);
        const file = input && input.files && input.files[0];
        if (!file) continue;
        setProofSubmitStatus(`Enviando ${i + 1}/${requiredPhotos.length}: ${photo.label}...`, "info", false);
        const asset = await uploadToCloudinaryAsset(file, { folder: "provas/" + callId });
        if (!asset || !asset.cloudinaryUrl) throw new Error("Upload sem URL retornada para " + photo.label + ".");
        uploadedPhotos.push(Object.assign({}, asset, {
          type: photo.key,
          label: photo.label,
          callId,
          uploadedBy: state.user.uid,
          uploadedByName: state.profile.nome || state.user.email
        }));
      }

      const replacedTypes = new Set(uploadedPhotos.map((photo) => photo.type));
      const proofPhotosMerged = existingPhotos.filter((photo) => !replacedTypes.has(photo.type)).concat(uploadedPhotos);
      let customerSignature = call.customerSignature || null;
      const sigBlob = await signatureBlob();
      if (sigBlob) {
        setProofSubmitStatus("Enviando assinatura do cliente...", "info", false);
        const sigAsset = await uploadToCloudinaryAsset(sigBlob, { folder: "assinaturas/" + callId, fileName: "assinatura-" + callId + ".png" });
        if (!sigAsset || !sigAsset.cloudinaryUrl) throw new Error("A assinatura foi enviada, mas não retornou URL.");
        customerSignature = Object.assign({}, sigAsset, {
          signatureUrl: sigAsset.cloudinaryUrl || "",
          name: $("signatureCustomerName").value.trim(),
          document: $("signatureCustomerDoc").value.trim(),
          acceptedText,
          signedAt: new Date().toISOString(),
          gps,
          driverId: state.user.uid,
          driverName: state.profile.nome || state.user.email
        });
      } else if (customerSignature) {
        customerSignature = Object.assign({}, customerSignature, { acceptedText, reusedAt: new Date().toISOString() });
      }

      const nextCall = Object.assign({}, call, { proofChecklist: checklist, proofPhotos: proofPhotosMerged, customerSignature });
      const nextProofStatus = signatureMissing ? "parcial" : proofStatusFor(nextCall);
      setProofSubmitStatus("Salvando provas no chamado...", "info", false);
      await db.collection("calls").doc(callId).set({
        proofChecklist: checklist,
        proofPhotos: proofPhotosMerged,
        customerSignature,
        proofStatus: nextProofStatus,
        proofUpdatedAt: new Date().toISOString(),
        proofUpdatedBy: state.user.uid,
        billingStatus: nextProofStatus === "completo" && call.billingStatus === "aguardando_provas" ? "a_faturar" : call.billingStatus || "aberto",
        timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista salvou checklist, fotos e assinatura do cliente" }),
        updatedAt: new Date().toISOString()
      }, { merge: true });

      let auditWarning = "";
      try {
        await db.collection("callProofs").add({
          callId,
          driverId: state.user.uid,
          driverName: state.profile.nome || state.user.email,
          vehicleId: call.vehicleId || "",
          customerId: call.customerId || "",
          protocol: callProtocolLabel(call, callId),
          insurance: call.insurance || "",
          checklist,
          photos: uploadedPhotos,
          customerSignature,
          proofStatus: nextProofStatus,
          gps,
          createdAt: new Date().toISOString()
        });
      } catch (proofLogErr) {
        auditWarning = " As provas foram salvas no chamado, mas o histórico callProofs não gravou: " + (proofLogErr && (proofLogErr.code || proofLogErr.message) || "sem detalhe") + ".";
        try {
          await db.collection("calls").doc(callId).set({ proofLogWarning: auditWarning, proofLogWarningAt: new Date().toISOString() }, { merge: true });
        } catch (_) {}
      }

      e.target.reset();
      if (signaturePad) {
        signaturePad.ctx.clearRect(0, 0, signaturePad.canvas.width, signaturePad.canvas.height);
        signaturePad.dirty = false;
      }
      const savedLabels = proofPhotoLabelList(uploadedPhotos) || "nenhuma foto nova, dados atualizados";
      const okMsg = nextProofStatus === "completo"
        ? "Provas completas e salvas. O chamado já pode ser finalizado." + auditWarning
        : "Provas salvas parcialmente: " + savedLabels + (signatureMissing ? ". Falta coletar a assinatura para liberar finalização." : ".") + auditWarning;
      setProofSubmitStatus(okMsg, auditWarning ? "warn" : "success");
    } catch (err) {
      const detail = err && (err.code || err.message) || "falha operacional";
      setProofSubmitStatus("Não consegui salvar as provas: " + detail, "danger");
    } finally {
      submit.disabled = false;
      submit.textContent = submit.dataset.originalText || "Salvar provas e assinatura";
    }
  });

  window.JM = window.JM || {};
  window.JM.motorista = { setStatus, startLocationForCall: startDriverPhoneLocation, stopDriverPhoneLocation, state };
  setupSignaturePad();
  if (typeof setupCollapsiblePanels === "function") {
    setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 });
    setTimeout(() => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 }), 250);
    window.addEventListener("load", () => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 }), { once: true });
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js?v=" + DRIVER_FLOW_VERSION).catch(() => {});
}());

